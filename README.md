# pi-telegram

One-way Telegram notifications for Pi agents.

This package gives Pi Telegram tools and a `telegram-notify` skill so you can say things like:

> When you're done with the job, send me a report via Telegram.

The integration is intentionally **agent → Telegram only**. It does not listen for Telegram replies, run a webhook, or turn Telegram into a second Pi chat thread.

## Install

Install from npm:

```bash
pi install npm:@wienerberliner/pi-telegram
```

Or try the local checkout while developing:

```bash
pi install /path/to/pi-telegram
```

For local development in this repository, `.pi/settings.json` loads the package root (`..`) after the project is trusted. Run `/trust` and `/reload` if Pi is already open.

## Setup

1. In Telegram, open [@BotFather](https://t.me/BotFather) and create a bot with `/newbot`.
2. Copy the bot token.
3. In Pi, run:

   ```text
   /setup-telegram-token
   ```

4. Paste the BotFather token into the secure Pi input prompt. This keeps the token out of the LLM chat transcript.
5. The command validates the token, saves it to `.env`, and asks you to send a message such as `hello world` to the bot.
6. After you send the Telegram message, press Enter in Pi. The command fetches the chat id with Telegram `getUpdates`, saves it to `.env`, and sends a confirmation message to Telegram.

The generated `.env` uses:

```env
PI_TELEGRAM_BOT_TOKEN=123456:your-bot-token
PI_TELEGRAM_CHAT_ID=123456789
```

The extension automatically reads `.env` from Pi's current working directory. Real environment variables also work, and the unprefixed names `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are supported.

## Usage

Ask Pi naturally:

```text
Run the test suite. When you're done, send me a report via Telegram.
```

```text
Send screenshots/final.png to me via Telegram with caption "Final screenshot".
```

```text
Send output/demo.m4a to Telegram as the demo audio.
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

## npm

Package page: <https://www.npmjs.com/package/@wienerberliner/pi-telegram>
