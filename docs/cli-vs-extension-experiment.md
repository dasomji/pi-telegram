# pi-telegram CLI vs Pi Extension Experiment

Date: 2026-07-09

## Question

Would `pi-telegram` be more effective as a Pi extension tool, a shell CLI, or both? The specific concern was token overhead: loading extension tools adds baseline prompt/tool-schema context, while a CLI avoids tool-schema bloat but may cost tokens when an agent has to discover command syntax.

## Setup

Implemented a local CLI entrypoint:

```bash
node /home/dev/Development/pi-daniel/extensions/pi-telegram/bin/pi-telegram.mjs send-message --message "..." --silent --json
```

The CLI uses the same config precedence as the extension:

1. Environment variables.
2. Project-local `.env`.
3. Global `~/.pi/agent/pi-telegram/.env`.

Experiment run id: `77616a34`

Artifacts:

- Tool-path report: `.pi-subagents/artifacts/outputs/77616a34/experiment/tool-agent.md`
- CLI-path report: `.pi-subagents/artifacts/outputs/77616a34/experiment/cli-agent.md`
- Tool transcript: `.pi-subagents/artifacts/77616a34_delegate_0_transcript.jsonl`
- CLI transcript: `.pi-subagents/artifacts/77616a34_delegate_1_transcript.jsonl`

## Results

| Path | Outcome | Notes |
| --- | --- | --- |
| Pi extension tool in fresh subagent | Failed | The `telegram-notify` skill documented `telegram_send_message`, but the fresh subagent runtime did not expose that direct tool. MCP had 0 servers/tools; search/describe/connect attempts failed. The subagent obeyed constraints and did not fall back to CLI. |
| CLI in fresh subagent | Succeeded | The subagent ran the provided command once. CLI returned JSON with `ok=true`, `chunks_sent=1`, one message id, and chat metadata. |

## Observed transcript / token metrics

These metrics are from subagent transcript `usage` records. They measure the child runs, not any parent-session extension tool schema bloat before launch.

| Metric | Tool-path child | CLI-path child |
| --- | ---: | ---: |
| Transcript bytes | 65,742 | 38,273 |
| Assistant messages | 9 | 4 |
| Tool calls | 8 | 3 |
| Tool results | 8 | 3 |
| Supervisor replies | 1 | 0 |
| Usage input tokens | 17,132 | 14,857 |
| Usage output tokens | 3,013 | 1,765 |
| Usage cache-read tokens | 104,448 | 36,864 |
| Reported child cost | 0.228274 | 0.145667 |

Interpretation: in this run, the CLI path was materially cheaper and more direct because the command was provided explicitly and the extension tool was not available inside the fresh delegate.

## Effectiveness observations

### CLI strengths

- Works in subagents that have ordinary shell access even when package extension tools are not exposed.
- Can be used outside Pi and from scripts/CI.
- Does not require loading Telegram tool schemas into every session.
- JSON output gives agents a simple success contract.
- Failure mode is familiar: shell command exits non-zero with stderr.

### CLI weaknesses

- If the prompt does not provide command syntax, the agent may spend tokens discovering `--help` or reading docs.
- Shell quoting is easier to get wrong than typed tool parameters.
- Secret setup via CLI needs care. The implementation now prefers `--bot-token-file` / `--bot-token-stdin`; raw `--bot-token` is supported but warned as unsafe.
- Less semantic guidance than Pi tool descriptions unless the prompt or docs are explicit.

### Extension strengths

- Best UX in the parent Pi session: the user can ask naturally and the tool schema communicates parameter names/types.
- Safer typed arguments and tool-specific guardrails.
- Good for one-way Telegram reports in normal Pi workflows once the extension is loaded.

### Extension weaknesses found

- Fresh subagents using the builtin `delegate` tool set did not receive `telegram_send_message` even though the parent session/package has the extension installed.
- The child could see the skill docs but not the actual tool, causing discovery churn and supervisor intervention.
- Extension tools add baseline schema/prompt overhead in sessions where they are available.

## Recommendation

Keep both.

- Keep the Pi extension for first-class parent-session UX and natural-language Telegram notifications.
- Ship the CLI as the portable, subagent-friendly, low-baseline-overhead path.
- For subagent workflows, prefer instructing children to use the CLI unless/until Pi subagents can explicitly expose package extension tools to child runtimes.
- Document the exact CLI command shape in prompts when token efficiency matters; that avoids discovery overhead.

## Follow-up ideas

1. Investigate whether pi-subagents can opt specific extension tools into a child agent tool list.
2. If possible, rerun a true tool-vs-CLI experiment where the tool child actually has `telegram_send_message` available.
3. Add a tiny smoke test around CLI parsing/config helpers if the package grows a test harness.
4. Consider extracting shared Telegram logic from `extensions/telegram.ts` and `bin/pi-telegram.mjs` to reduce duplication once the CLI stabilizes.
