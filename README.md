# pi-telegram

One-way Telegram notifications for Pi agents.

This package gives Pi Telegram tools and a `telegram-notify` skill so you can say things like:

> When you're done with the job, send me a report via Telegram.

The integration is intentionally **agent → Telegram only**. It does not listen for Telegram replies, run a webhook, or turn Telegram into a second Pi chat thread.

## Setup

1. In Telegram, open [@BotFather](https://t.me/BotFather) and create a bot with `/newbot`.
2. Copy the bot token and export it locally:

   ```bash
   export PI_TELEGRAM_BOT_TOKEN="123456:your-bot-token"
   ```

3. Start a chat with your new bot from the Telegram account that should receive Pi notifications, and send the bot any message.
4. Find your chat id. A simple setup-only way is:

   ```bash
   curl "https://api.telegram.org/bot$PI_TELEGRAM_BOT_TOKEN/getUpdates"
   ```

   Look for `message.chat.id` in the JSON response.

5. Store the values in `.env` in the directory where you start Pi, or export them before starting Pi:

   ```bash
   cp .env.example .env
   # edit .env with your real token/chat id
   pi
   ```

   ```bash
   export PI_TELEGRAM_CHAT_ID="123456789"
   pi
   ```

   The extension automatically reads `.env` from Pi's current working directory. The unprefixed names `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` also work.

## Usage

Ask Pi naturally:

```text
Run the test suite. When you're done, send me a report via Telegram.
```

You can also test the extension command from Pi:

```text
/telegram-test Hello from Pi
```

## Tools

### `telegram_send_message`

Sends text to Telegram using the Bot API `sendMessage` method.

Parameters:

- `message` — text to send. Long messages are split into Telegram-sized chunks.
- `chat_id` — optional override for the configured chat id or `@channelusername`.
- `parse_mode` — optional `HTML`, `MarkdownV2`, or `Markdown`; omit for plain text.
- `disable_notification` — optional silent delivery.

### `telegram_send_image`

Sends an image/photo using the Bot API `sendPhoto` method.

Parameters:

- `source` — local image path, absolute image path, HTTP(S) URL, or Telegram `file_id`.
- `caption` — optional caption, max 1024 characters.
- `chat_id`, `parse_mode`, `disable_notification` — same as text messages.

Local image files are uploaded with `multipart/form-data`. Telegram's `sendPhoto` limit is 10 MB.

### `telegram_send_audio`

Sends an audio file using the Bot API `sendAudio` method.

Parameters:

- `source` — local audio path, absolute audio path, HTTP(S) URL, or Telegram `file_id`.
- `caption` — optional caption, max 1024 characters.
- `title` — optional track title.
- `performer` — optional performer/artist.
- `duration` — optional duration in seconds.
- `chat_id`, `parse_mode`, `disable_notification` — same as text messages.

Local audio files are uploaded with `multipart/form-data`. Telegram documents `sendAudio` for MP3/M4A music-player audio and currently allows files up to 50 MB.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `PI_TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather. |
| `PI_TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_ID` | yes by default | Target chat id. Can be overridden per tool call with `chat_id`. |
| `PI_TELEGRAM_API_BASE` / `TELEGRAM_API_BASE` | no | Defaults to `https://api.telegram.org`. |

Configuration can come from real environment variables or from a gitignored `.env` file in Pi's current working directory.

## Install as a Pi package

From a local checkout:

```bash
pi install /path/to/pi-telegram
```

For local development in this repository, `.pi/settings.json` loads the package root (`..`) after the project is trusted. Run `/trust` and `/reload` if Pi is already open.
