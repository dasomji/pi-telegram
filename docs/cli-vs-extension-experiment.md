# pi-telegram CLI vs Pi Extension Experiment

Date: 2026-07-09

## Question

Would `pi-telegram` be more effective as a Pi extension tool, a shell CLI, or both? The specific concern was token overhead: loading extension tools adds baseline prompt/tool-schema context, while a CLI avoids tool-schema bloat but may cost tokens when an agent has to discover command syntax.

## Implementation

The package now ships both surfaces:

- Pi extension tools: `telegram_send_message`, `telegram_send_image`, `telegram_send_audio`, and package support for file sends.
- CLI binary: `pi-telegram`, published in `@wienerberliner/pi-telegram@0.1.7`.

Example CLI send:

```bash
pi-telegram send-message --message "Build finished" --json
```

The CLI uses the same config precedence as the extension:

1. Environment variables.
2. Project-local `.env`.
3. Global `~/.pi/agent/pi-telegram/.env`.

## Availability diagnosis

The first comparison run was invalid.

### Extension tool availability problem

Run `77616a34` showed the tool-path child could read the `telegram-notify` skill docs, but could not call `telegram_send_message`. Root cause: global subagent overrides in `~/.pi/agent/settings.json` explicitly constrained builtin `delegate` / `worker` tool lists and did not include Telegram extension tools.

Fix applied locally:

- Added `telegram_send_message`, `telegram_send_image`, and `telegram_send_audio` to the `delegate` and `worker` subagent tool allowlists in `~/.pi/agent/settings.json`.
- Confirmed with `subagent get delegate` that `telegram_send_message` appears in the child tool list.

### CLI availability problem

The npm `bin` existed under Pi's private install, but `pi-telegram` was not on the shell `PATH`. A local symlink was added:

```text
~/.local/bin/pi-telegram -> ~/.pi/agent/npm/node_modules/.bin/pi-telegram
```

That exposed a real CLI bug: running through a symlink produced no output because the entrypoint check only worked when invoking the real file path directly. Fixed in `0.1.7` by running the CLI main function unconditionally in the bin entrypoint.

Validation after fix:

```bash
pi-telegram --help
pi-telegram send-message --message 'PATH CLI dry run after 0.1.7' --dry-run --json
```

Both passed.

## Invalid first run: `77616a34`

Artifacts:

- Tool-path report: `.pi-subagents/artifacts/outputs/77616a34/experiment/tool-agent.md`
- CLI-path report: `.pi-subagents/artifacts/outputs/77616a34/experiment/cli-agent.md`

| Path | Outcome | Why |
| --- | --- | --- |
| Pi extension tool | Failed | `telegram_send_message` was not exposed to the fresh subagent runtime. |
| CLI | Succeeded | The child was given the direct `node .../bin/pi-telegram.mjs` path. |

Because only one side was actually available, this run should not be used as the comparison result.

## Fair rerun: `c174a361`

After fixing both availability issues, two fresh `delegate` subagents were launched with matched send tasks:

- Tool child: must use `telegram_send_message`; must not use CLI/shell for Telegram.
- CLI child: must use `pi-telegram`; must not use direct Telegram Pi tools.

Artifacts:

- Tool-path report: `.pi-subagents/artifacts/outputs/c174a361/experiment-rerun/tool-agent.md`
- CLI-path report: `.pi-subagents/artifacts/outputs/c174a361/experiment-rerun/cli-agent.md`
- Tool transcript: `.pi-subagents/artifacts/c174a361_delegate_0_transcript.jsonl`
- CLI transcript: `.pi-subagents/artifacts/c174a361_delegate_1_transcript.jsonl`

| Path | Outcome | Notes |
| --- | --- | --- |
| Pi extension tool | Succeeded | Used `telegram_send_message` directly. No friction or fallback. |
| CLI | Succeeded | Used `pi-telegram --help`, then `pi-telegram send-message ... --json`. No fallback. |

## Rerun token / transcript metrics

These metrics come from child transcript `usage` records. They measure the child runs, not the parent-session cost of having extension schemas loaded before launch.

| Metric | Tool-path child | CLI-path child |
| --- | ---: | ---: |
| Transcript bytes | 26,260 | 39,749 |
| Assistant messages | 3 | 5 |
| Tool calls | 2 | 4 |
| Tool results | 2 | 4 |
| Usage input tokens | 14,262 | 29,815 |
| Usage output tokens | 1,122 | 1,409 |
| Usage cache-read tokens | 26,112 | 39,936 |
| Reported child cost | 0.118026 | 0.211313 |

## Interpretation

Once both paths were actually available, the direct Pi tool was cheaper and simpler for the child:

- Tool path: one semantic tool call plus artifact write.
- CLI path: help/discovery call, shell send command, artifact write, and validation shell call.

The CLI path may still win in sessions where Telegram tools are not loaded at all, because it avoids extension tool-schema baseline overhead. But inside a child runtime that already exposes the Telegram tool, the tool is more efficient and less error-prone.

## Recommendation

Keep both surfaces.

- Use the Pi extension for normal Pi UX and subagents that have the Telegram tool in their allowlist.
- Use the CLI for portability, scripts, CI, and subagent contexts where extension tools are intentionally not loaded.
- For fair subagent comparisons, first verify availability:
  - `subagent get delegate` should list `telegram_send_message` for the tool path.
  - `which pi-telegram && pi-telegram --help` should work for the CLI path.

## Follow-up ideas

1. Add a small documented setup step for making package CLIs available on PATH after `pi install` / `pi update`, if Pi does not do that automatically.
2. Consider a Pi/subagents setting convention for opt-in extension tools in child agents so installed package tools do not silently disappear behind explicit allowlists.
3. Add tests around CLI symlink invocation if the package gains an automated test harness.
4. Eventually extract shared Telegram config/send logic from `extensions/telegram.ts` and `bin/pi-telegram.mjs` to reduce duplication.
