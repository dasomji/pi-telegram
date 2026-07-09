---
name: telegram-notify
description: Send one-way Telegram notifications or reports to the user. Use when the user asks to be notified via Telegram, says "send me a report via Telegram", "message me when done", or wants Pi to send status updates through Telegram.
license: MIT
---

# Telegram Notify

Use the Telegram tools when the user explicitly asks for a Telegram notification, update, report, image, audio file, or general file/document artifact.

Available tools:

- `telegram_send_message` — send text notifications/reports.
- `telegram_send_image` — send image/photo files, screenshots, diagrams, or generated visuals.
- `telegram_send_file` — send general files/documents such as APKs, Android app bundles, logs, reports, ZIPs, PDFs, and build artifacts.
- `telegram_send_audio` — send audio files, recordings, or generated audio.

## Rules

- Telegram is one-way from Pi to the user. Do not wait for Telegram replies and do not use it for clarification questions.
- Send only information or files the user requested or would reasonably expect for the task.
- Keep messages concise. For a final job report, include:
  - outcome/status
  - important files or artifacts
  - validation performed
  - any remaining risks or next steps
- Do not send secrets, API keys, bot tokens, credentials, private environment values, or unrelated private files.
- Before sending a local image/audio/general file, make sure the path points to the intended file.
- Do not send secrets, API keys, signing keys, keystores, credential files, `.env` files, or unrelated private files via Telegram.
- Use plain text by default. Only set `parse_mode` when the user specifically asks for HTML/Markdown formatting and the content is safe for that parse mode.

## Typical Flow

If the user says, "when you're done with the job send me a report via telegram":

1. Do the job normally.
2. Before your final chat response, call `telegram_send_message` with a concise final report.
3. If the user requested a generated image/audio/file artifact, call `telegram_send_image`, `telegram_send_audio`, or `telegram_send_file` with the artifact path and a short caption.
4. In the final chat response, mention what was sent via Telegram.

If a Telegram tool reports missing configuration, tell the user to run `/setup-telegram-token`. The setup command writes global config to `~/.pi/agent/pi-telegram/.env` so all Pi sessions can use it; project-local `.env` files can still override it.
