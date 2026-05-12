/**
 * pi-wafer — Wafer Pass provider for pi.
 *
 * Registers the Wafer provider + paste-token OAuth flow. When a Wafer model
 * is the active model, replaces the built-in footer with one that mirrors it
 * but swaps the `$0.00 (sub)` cost field for the Wafer request quota and the
 * time remaining in the current quota window — e.g. `50/100 1hr` or `30m`.
 *
 * For any other provider the built-in footer is left untouched.
 */

import type { AssistantMessage, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER = "wafer.ai";
const QUOTA_URL = "https://pass.wafer.ai/v1/inference/quota";

// ── models ────────────────────────────────────────────────────────────────
const baseCompat = { supportsDeveloperRole: true, supportsReasoningEffort: false };
const baseModel = {
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32768,
};

const MODELS = [
	{ ...baseModel, id: "Qwen3.5-397B-A17B", name: "Qwen 3.5 397B", contextWindow: 262144, compat: baseCompat },
	{ ...baseModel, id: "GLM-5.1", name: "GLM 5.1", contextWindow: 202752, compat: baseCompat },
];

// ── formatters ────────────────────────────────────────────────────────────
const fmtTokens = (n: number) =>
	n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;

function fmtRemaining(ms: number): string {
	if (ms <= 0) return "0m";
	const min = Math.ceil(ms / 60_000);
	return min < 60 ? `${min}m` : `${Math.ceil(min / 60)}hr`;
}

// ── extension ─────────────────────────────────────────────────────────────
type Quota = { used: number; limit: number; windowEnd?: number };

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let quota: Quota | undefined;
	let footerInstalled = false;
	let triggerRender: (() => void) | undefined;

	pi.registerProvider(PROVIDER, {
		name: "Wafer",
		baseUrl: "https://pass.wafer.ai/v1",
		apiKey: "WAFER_API_KEY",
		api: "openai-completions",
		models: MODELS,
		oauth: {
			name: "Wafer Pass",
			async login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				cb.onAuth({ url: "https://www.wafer.ai/pass" });
				const key = (await cb.onPrompt({ message: "Paste your Wafer API key:" })).trim();
				if (!key) throw new Error("No Wafer API key provided");
				// 20-year expiry — Wafer keys are long-lived.
				return { access: key, refresh: key, expires: Date.now() + 20 * 365 * 86_400_000 };
			},
			async refreshToken(c: OAuthCredentials) {
				return c;
			},
			getApiKey: (c: OAuthCredentials) => c.access,
		},
	});

	// The Wafer endpoint negotiates a compression fetch can't auto-decode, so
	// we send `Accept-Encoding: identity` to force a plain JSON response.
	async function refreshQuota() {
		if (!ctx?.model || ctx.model.provider !== PROVIDER) return;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth?.ok || !auth.apiKey) return;
			const res = await fetch(QUOTA_URL, {
				headers: {
					Authorization: `Bearer ${auth.apiKey}`,
					Accept: "application/json",
					"Accept-Encoding": "identity",
				},
			});
			if (!res.ok) return;
			const body = (await res.json()) as {
				request_count?: number;
				included_request_limit?: number;
				window_end?: string;
			};
			if (typeof body.request_count !== "number" || typeof body.included_request_limit !== "number") return;
			const windowEnd = body.window_end ? Date.parse(body.window_end) : NaN;
			quota = {
				used: body.request_count,
				limit: body.included_request_limit,
				windowEnd: Number.isFinite(windowEnd) ? windowEnd : undefined,
			};
			triggerRender?.();
		} catch {
			// network/parse errors — leave quota stale
		}
	}

	function ensureFooter() {
		if (!ctx) return;
		const isWafer = ctx.model?.provider === PROVIDER;
		if (isWafer && !footerInstalled) {
			ctx.ui.setFooter(footerFactory);
			footerInstalled = true;
		} else if (!isWafer && footerInstalled) {
			ctx.ui.setFooter(undefined);
			footerInstalled = false;
		}
	}

	const footerFactory = (tui: any, theme: any, fd: any) => {
		triggerRender = () => tui.requestRender();
		const unsubBranch = fd.onBranchChange(triggerRender);
		// Tick once a minute so the "remaining" clock decreases visibly.
		const tick = setInterval(() => triggerRender?.(), 60_000);
		return {
			dispose: () => {
				unsubBranch();
				clearInterval(tick);
				triggerRender = undefined;
			},
			invalidate() {},
			render: (width: number) => renderFooter(width, theme, fd),
		};
	};

	function renderFooter(width: number, theme: any, fd: any): string[] {
		if (!ctx) return [];
		const { model, sessionManager: sm } = ctx;

		// Token totals across the whole session.
		let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
		for (const e of sm.getEntries()) {
			if (e.type !== "message" || e.message.role !== "assistant") continue;
			const u = (e.message as AssistantMessage).usage;
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			cacheWrite += u.cacheWrite;
		}

		// Context %
		const cu = ctx.getContextUsage();
		const ctxWindow = cu?.contextWindow ?? model?.contextWindow ?? 0;
		const ctxPct = cu?.percent ?? 0;
		const ctxText =
			cu?.percent !== null
				? `${ctxPct.toFixed(1)}%/${fmtTokens(ctxWindow)} (auto)`
				: `?/${fmtTokens(ctxWindow)} (auto)`;
		const ctxColored = ctxPct > 90 ? theme.fg("error", ctxText) : ctxPct > 70 ? theme.fg("warning", ctxText) : ctxText;

		// Path + branch + session name
		let pwd = sm.getCwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
		const branch = fd.getGitBranch();
		if (branch) pwd += ` (${branch})`;
		const sessionName = sm.getSessionName();
		if (sessionName) pwd += ` • ${sessionName}`;

		// Stats line: tokens • quota+window • context%
		const stats: string[] = [];
		if (input) stats.push(`↑${fmtTokens(input)}`);
		if (output) stats.push(`↓${fmtTokens(output)}`);
		if (cacheRead) stats.push(`R${fmtTokens(cacheRead)}`);
		if (cacheWrite) stats.push(`W${fmtTokens(cacheWrite)}`);
		stats.push(formatQuota(quota));
		stats.push(ctxColored);

		// Right side: model [• thinking] [(provider) prefix]
		const modelName = model?.id || "no-model";
		let right = modelName;
		if (model?.reasoning) {
			const lvl = pi.getThinkingLevel?.() ?? "off";
			right = lvl === "off" ? `${modelName} • thinking off` : `${modelName} • ${lvl}`;
		}

		let left = stats.join(" ");
		let lw = visibleWidth(left);
		if (lw > width) {
			left = truncateToWidth(left, width, "...");
			lw = visibleWidth(left);
		}
		if (fd.getAvailableProviderCount() > 1 && model) {
			const withProvider = `(${model.provider}) ${right}`;
			if (lw + 2 + visibleWidth(withProvider) <= width) right = withProvider;
		}
		const padding = " ".repeat(Math.max(0, width - lw - visibleWidth(right)));
		const statsLine = left + padding + right;

		const lines = [
			truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
			theme.fg("dim", left) + theme.fg("dim", statsLine.slice(left.length)),
		];

		// Other extensions' status texts, alphabetised.
		const exts = fd.getExtensionStatuses();
		if (exts.size > 0) {
			const text = [...exts.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
				.join(" ");
			lines.push(truncateToWidth(text, width, theme.fg("dim", "...")));
		}
		return lines;
	}

	function formatQuota(q: Quota | undefined): string {
		if (!q) return "…";
		const base = `${q.used}/${q.limit}`;
		if (!q.windowEnd) return base;
		return `${base} ${fmtRemaining(q.windowEnd - Date.now())}`;
	}

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		ensureFooter();
		await refreshQuota();
	});
	pi.on("model_select", async (_e, c) => {
		ctx = c;
		ensureFooter();
		await refreshQuota();
	});
	// Refresh the moment a provider HTTP response arrives — fires per
	// API call, before the stream body is consumed and well before the turn
	// finishes (which waits for streaming + tool execution).
	pi.on("after_provider_response", async (_e, c) => {
		ctx = c;
		await refreshQuota();
	});
	pi.on("session_shutdown", () => {
		ctx = undefined;
		quota = undefined;
		footerInstalled = false;
		triggerRender = undefined;
	});
}
