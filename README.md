# pi-wafer

A [pi](https://pi.dev) extension for the [Wafer Pass](https://www.wafer.ai/pass) provider — get every Wafer model in your pi model picker (DeepSeek V4 Pro, Qwen 3.5 397B, GLM 5.1, MiniMax M2.7, …), and a footer that shows your **live request quota** and the **time remaining until your next quota window** every turn.

```
↑12.4k ↓3.1k 47/100 1hr 18.2%/262k (auto)        DeepSeek-V4-Pro • high
```

No more guessing how many requests you have left or when the limit resets — pi tells you in the same status row that normally shows your spend.

## Features

- Adds the `wafer.ai` provider to pi with all current Wafer Pass models pre-configured (context windows, reasoning support, thinking format)
- Paste-token "OAuth" flow: pi opens [wafer.ai/pass](https://www.wafer.ai/pass), you paste your key, done
- Custom footer (only when a Wafer model is active — leaves your other providers' footers untouched) that replaces the `$0.00 (sub)` cost field with:
  - `used/limit` request quota (e.g. `47/100`)
  - Time remaining in the current quota window (e.g. `1hr` or `30m`)
- Quota auto-refreshes on session start, model change, and after every assistant turn
- Footer ticks every minute so the countdown stays accurate without extra requests

## Requirements

- pi with extension/package support
- A [Wafer Pass](https://www.wafer.ai/pass) account and API key

## Install

### From npm

```bash
pi install npm:@zackify/pi-wafer
```

Then reload pi:

```text
/reload
```

### Manual install

Copy the extension into your global pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/pi-wafer
cp index.ts ~/.pi/agent/extensions/pi-wafer/index.ts
```

Or install it only for one project:

```bash
mkdir -p .pi/extensions/pi-wafer
cp index.ts .pi/extensions/pi-wafer/index.ts
```

Then reload pi:

```text
/reload
```

## Usage

1. Open the model picker in pi (`/model`).
2. Pick any model under the `wafer.ai` provider.
3. The first time, pi opens [wafer.ai/pass](https://www.wafer.ai/pass) and prompts you to paste your API key. Paste it and hit enter — it's stored in `~/.pi/agent/auth.json` like any other OAuth credential.
4. Use pi normally. The footer's stats row will read something like:

   ```
   ↑12.4k ↓3.1k 47/100 1hr 18.2%/262k (auto)        DeepSeek-V4-Pro • high
   ```

   - `47/100` — requests used / included this window
   - `1hr` — time remaining until the window rolls over (`30m`, `5m`, `0m` etc.)
   - The rest is the standard pi footer (cumulative tokens, context %, model + thinking level)

If pi can't reach the quota endpoint the field shows `…` instead of crashing the footer.

## Models

The following models are registered automatically. They live under the `wafer.ai` provider; pricing is reported as `$0` because Wafer Pass is a flat-rate subscription.

| ID                  | Name             | Context | Reasoning |
| ------------------- | ---------------- | ------- | --------- |
| `DeepSeek-V4-Pro`   | DeepSeek V4 Pro  | 256k    | yes (DeepSeek thinking format) |
| `Qwen3.5-397B-A17B` | Qwen 3.5 397B    | 256k    | yes |
| `GLM-5.1`           | GLM 5.1          | 198k    | yes |
| `MiniMax-M2.7`      | MiniMax M2.7     | 200k    | yes |

To add or update models, edit the `MODELS` array at the top of `index.ts`.

## Privacy notes

- Your Wafer API key is stored locally by pi in `~/.pi/agent/auth.json` under the `wafer.ai` provider, the same place every other OAuth provider lives.
- The extension only talks to `pass.wafer.ai` — once on startup / model change / after each turn — to read your quota.
- No telemetry. No logs are written by this extension.

## Troubleshooting

### Footer shows `…` where the quota should be

That means the quota fetch hasn't completed (or failed silently). Common causes:

- You haven't selected a Wafer model yet — pick one with `/model`.
- Your API key is missing or rejected — re-run `/auth wafer.ai` to paste a new one.
- `pass.wafer.ai` is unreachable from your network.

### The quota number isn't updating after a request

It refreshes on the `agent_end` event (i.e. once a turn completes). If you want a manual refresh, switch models away and back.

## Files

- `index.ts` — extension source
- `package.json` — pi package metadata for `@zackify/pi-wafer`, including the `pi-package` keyword for the [pi.dev](https://pi.dev) registry
- `.github/workflows/publish.yml` — npm publish workflow for GitHub releases
