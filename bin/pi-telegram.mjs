#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
const GLOBAL_CONFIG_DIR_ENV = "PI_TELEGRAM_CONFIG_DIR";
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_CHUNK_LIMIT = 4000;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_AUDIO_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REQUEST_TEXT_LENGTH = 20_000;
const ALLOWED_PARSE_MODES = new Set(["MarkdownV2", "HTML", "Markdown"]);

function parseDotEnv(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue = ""] = match;
    let value = rawValue.trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const commentStart = value.search(/\s#/);
      if (commentStart >= 0) value = value.slice(0, commentStart).trimEnd();
    }

    values[key] = value.replace(/\\n/g, "\n");
  }

  return values;
}

function projectDotEnvPath(cwd) {
  return join(cwd, ".env");
}

function globalConfigDir() {
  return process.env[GLOBAL_CONFIG_DIR_ENV]?.trim() || join(homedir(), ".pi", "agent", "pi-telegram");
}

function globalDotEnvPath() {
  return join(globalConfigDir(), ".env");
}

function loadDotEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, "utf8"));
}

function withoutBlankValues(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => String(value).trim().length > 0));
}

function loadConfigDotEnv(cwd = process.cwd()) {
  return {
    ...withoutBlankValues(loadDotEnvFile(globalDotEnvPath())),
    ...withoutBlankValues(loadDotEnvFile(projectDotEnvPath(cwd))),
  };
}

function firstConfigValue(dotEnv, ...names) {
  for (const name of names) {
    const value = (process.env[name] ?? dotEnv[name])?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveConfig(cwd = process.cwd()) {
  const dotEnv = loadConfigDotEnv(cwd);
  return {
    botToken: firstConfigValue(dotEnv, "PI_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN") ?? "",
    chatId: firstConfigValue(dotEnv, "PI_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"),
    apiBase: (firstConfigValue(dotEnv, "PI_TELEGRAM_API_BASE", "TELEGRAM_API_BASE") ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, ""),
  };
}

function formatDotEnvValue(value) {
  if (/^[A-Za-z0-9_:@./+=-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function writeDotEnvValues(path, updates) {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return line;

    const [, prefix, key, separator] = match;
    if (!pending.has(key)) return line;

    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${prefix}${key}${separator}${formatDotEnvValue(value)}`;
  });

  for (const [key, value] of pending) {
    next.push(`${key}=${formatDotEnvValue(value)}`);
  }

  writeFileSync(path, `${next.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

function splitTelegramMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (limit < 1) throw new Error("Telegram message split limit must be positive.");

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new Error("Telegram message text must not be empty.");

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
    const breakAt = candidates.find((index) => index >= Math.floor(limit * 0.6)) ?? limit;

    const chunk = remaining.slice(0, breakAt).trimEnd();
    chunks.push(chunk || remaining.slice(0, limit));
    remaining = remaining.slice(chunk ? breakAt : limit).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function parseBoolean(value, flag) {
  if (value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${flag} expects a boolean value when provided with =value.`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const rawKey = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const key = rawKey.replace(/-/g, "_");
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (["disable-notification", "disable-content-type-detection", "silent", "json", "dry-run"].includes(rawKey)) {
      options[key] = parseBoolean(inlineValue, `--${rawKey}`);
      continue;
    }

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positional, options };
}

function stringOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === false) return undefined;
  return String(value);
}

function readTextInput(options, primaryKey, fallbackKey) {
  const direct = stringOption(options, primaryKey) ?? (fallbackKey ? stringOption(options, fallbackKey) : undefined);
  if (direct !== undefined) return direct;

  const file = stringOption(options, `${primaryKey}_file`) ?? (fallbackKey ? stringOption(options, `${fallbackKey}_file`) : undefined);
  if (file) return readFileSync(resolve(process.cwd(), file), "utf8");

  return undefined;
}

function validateChatAndParseMode(params, config) {
  if (!config.botToken) {
    throw new Error("Telegram is not configured: set PI_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) to your BotFather token.");
  }

  const chatId = params.chat_id?.trim() || config.chatId;
  if (!chatId) {
    throw new Error("Telegram chat is not configured: set PI_TELEGRAM_CHAT_ID (or TELEGRAM_CHAT_ID), or pass --chat-id.");
  }

  const parseMode = params.parse_mode?.trim();
  if (parseMode && !ALLOWED_PARSE_MODES.has(parseMode)) {
    throw new Error(`Unsupported Telegram parse_mode '${parseMode}'. Use HTML, MarkdownV2, Markdown, or omit parse_mode for plain text.`);
  }

  return { chatId, parseMode };
}

function validateTextParams(params, config) {
  if (params.message.length > MAX_REQUEST_TEXT_LENGTH) {
    throw new Error(`Telegram message is too long (${params.message.length} chars). Keep it under ${MAX_REQUEST_TEXT_LENGTH} chars.`);
  }
  return validateChatAndParseMode(params, config);
}

function validateCaption(caption) {
  const trimmed = caption?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > TELEGRAM_CAPTION_LIMIT) {
    throw new Error(`Telegram media caption is too long (${trimmed.length} chars). Keep it under ${TELEGRAM_CAPTION_LIMIT} chars.`);
  }
  return trimmed;
}

function normalizeSource(source) {
  const trimmed = source.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isHttpUrl(source) {
  return /^https?:\/\//i.test(source);
}

function resolveLocalSource(source, cwd) {
  if (isHttpUrl(source)) return undefined;

  const resolved = resolve(cwd, source);
  if (!existsSync(resolved)) return undefined;

  const stats = statSync(resolved);
  if (!stats.isFile()) throw new Error(`Telegram media source is not a file: ${source}`);
  return resolved;
}

function mimeTypeForPath(path, kind) {
  const lower = path.toLowerCase();

  if (kind === "photo") {
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
  }

  if (kind === "audio") {
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    return "audio/mpeg";
  }

  if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
  if (lower.endsWith(".aab")) return "application/octet-stream";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".md")) return "text/plain";
  return "application/octet-stream";
}

function buildJsonBody(fields) {
  const body = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return JSON.stringify(body);
}

function buildMultipartBody(fields, media) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }

  const fileBytes = readFileSync(media.filePath);
  const blob = new Blob([fileBytes], { type: mimeTypeForPath(media.filePath, media.kind) });
  form.append(media.fieldName, blob, media.filename?.trim() || basename(media.filePath));

  return form;
}

async function callTelegramApi(config, method, body) {
  const headers = typeof body === "string" ? { "content-type": "application/json" } : undefined;
  const response = await fetch(`${config.apiBase}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers,
    body,
  });

  const responseBody = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    throw new Error(`Telegram API returned non-JSON response with HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
  }

  if (!response.ok || !payload.ok) {
    const reason = payload.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API ${method} failed${payload.error_code ? ` (${payload.error_code})` : ""}: ${reason}`);
  }

  return payload;
}

async function sendTelegramChunk(config, chunk, options) {
  return callTelegramApi(
    config,
    "sendMessage",
    buildJsonBody({
      chat_id: options.chatId,
      text: chunk,
      parse_mode: options.parseMode,
      disable_notification: options.disableNotification,
    }),
  );
}

async function sendTelegramMedia(config, method, params, options) {
  const { chatId, parseMode } = validateChatAndParseMode(params, config);
  const source = normalizeSource(params.source);
  const caption = validateCaption(params.caption);
  const localPath = resolveLocalSource(source, process.cwd());

  const fields = {
    chat_id: chatId,
    caption,
    parse_mode: parseMode,
    disable_notification: params.disable_notification,
  };

  if (method === "sendAudio") {
    fields.duration = params.duration;
    fields.performer = params.performer;
    fields.title = params.title;
  }

  if (method === "sendDocument") {
    fields.disable_content_type_detection = params.disable_content_type_detection;
  }

  if (localPath) {
    const stats = statSync(localPath);
    if (stats.size > options.maxBytes) {
      throw new Error(`Telegram ${options.mediaField} file is too large (${stats.size} bytes). Limit is ${options.maxBytes} bytes.`);
    }

    return callTelegramApi(
      config,
      method,
      buildMultipartBody(fields, {
        fieldName: options.mediaField,
        filePath: localPath,
        kind: options.mediaField,
        filename: params.filename,
      }),
    );
  }

  return callTelegramApi(config, method, buildJsonBody({ ...fields, [options.mediaField]: source }));
}

function maybePrintJson(options, value) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function summarizeMessageResults(results) {
  const ids = results.map((result) => result.result?.message_id).filter((id) => id !== undefined);
  const chat = results[0]?.result?.chat;
  return {
    ok: true,
    chunks_sent: results.length,
    message_ids: ids,
    chat: chat ? { id: chat.id, type: chat.type, title: chat.title, username: chat.username } : undefined,
  };
}

function summarizeMediaResult(result, kind) {
  const chat = result.result?.chat;
  return {
    ok: true,
    kind,
    message_id: result.result?.message_id,
    chat: chat ? { id: chat.id, type: chat.type, title: chat.title, username: chat.username } : undefined,
  };
}

async function commandSendMessage(options) {
  const message = readTextInput(options, "message", "text");
  if (!message) throw new Error("send-message requires --message <text> or --message-file <path>.");

  const params = {
    message,
    chat_id: stringOption(options, "chat_id"),
    parse_mode: stringOption(options, "parse_mode"),
    disable_notification: Boolean(options.disable_notification || options.silent),
  };

  const config = resolveConfig();
  const { chatId, parseMode } = validateTextParams(params, config);
  const chunks = splitTelegramMessage(params.message, TELEGRAM_SAFE_CHUNK_LIMIT);

  if (options.dry_run) {
    const summary = { ok: true, dry_run: true, command: "send-message", chunks: chunks.length, chars: params.message.length, chat_configured: Boolean(chatId) };
    maybePrintJson(options, summary);
    if (!options.json) console.log(`Dry run: would send ${chunks.length} message chunk(s).`);
    return;
  }

  const results = [];
  for (const [index, chunk] of chunks.entries()) {
    const text = chunks.length === 1 ? chunk : `(${index + 1}/${chunks.length})\n${chunk}`;
    results.push(await sendTelegramChunk(config, text, {
      chatId,
      parseMode,
      disableNotification: params.disable_notification,
    }));
  }

  const summary = summarizeMessageResults(results);
  maybePrintJson(options, summary);
  if (!options.json) console.log(`Sent ${results.length} Telegram message chunk(s).`);
}

async function commandSendMedia(command, options) {
  const source = stringOption(options, "source") ?? stringOption(options, command === "send-file" ? "file" : command.replace("send-", ""));
  if (!source) throw new Error(`${command} requires --source <path-or-url>.`);

  const durationText = stringOption(options, "duration");
  const duration = durationText === undefined ? undefined : Number(durationText);
  if (duration !== undefined && (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0)) {
    throw new Error("--duration must be a non-negative integer number of seconds.");
  }

  const params = {
    source,
    caption: readTextInput(options, "caption"),
    chat_id: stringOption(options, "chat_id"),
    parse_mode: stringOption(options, "parse_mode"),
    disable_notification: Boolean(options.disable_notification || options.silent),
    filename: stringOption(options, "filename"),
    disable_content_type_detection: Boolean(options.disable_content_type_detection),
    duration,
    performer: stringOption(options, "performer"),
    title: stringOption(options, "title"),
  };

  const mediaByCommand = {
    "send-image": { method: "sendPhoto", mediaField: "photo", maxBytes: TELEGRAM_PHOTO_MAX_BYTES, kind: "image" },
    "send-audio": { method: "sendAudio", mediaField: "audio", maxBytes: TELEGRAM_AUDIO_MAX_BYTES, kind: "audio" },
    "send-file": { method: "sendDocument", mediaField: "document", maxBytes: TELEGRAM_DOCUMENT_MAX_BYTES, kind: "file" },
  };
  const media = mediaByCommand[command];

  const config = resolveConfig();
  validateChatAndParseMode(params, config);
  const localPath = resolveLocalSource(normalizeSource(params.source), process.cwd());
  if (localPath) {
    const stats = statSync(localPath);
    if (stats.size > media.maxBytes) {
      throw new Error(`Telegram ${media.mediaField} file is too large (${stats.size} bytes). Limit is ${media.maxBytes} bytes.`);
    }
  }

  if (options.dry_run) {
    const summary = { ok: true, dry_run: true, command, source_type: localPath ? "local-file" : "remote-or-file-id", local_size_bytes: localPath ? statSync(localPath).size : undefined };
    maybePrintJson(options, summary);
    if (!options.json) console.log(`Dry run: would send Telegram ${media.kind}.`);
    return;
  }

  const result = await sendTelegramMedia(config, media.method, params, { mediaField: media.mediaField, maxBytes: media.maxBytes });
  const summary = summarizeMediaResult(result, media.kind);
  maybePrintJson(options, summary);
  if (!options.json) console.log(`Sent Telegram ${media.kind}.`);
}

function readBotTokenForSetup(options) {
  const tokenFile = stringOption(options, "bot_token_file") ?? stringOption(options, "token_file");
  if (tokenFile) return readFileSync(resolve(process.cwd(), tokenFile), "utf8").trim();

  if (options.bot_token_stdin || options.token_stdin) {
    return readFileSync(0, "utf8").trim();
  }

  const argvToken = stringOption(options, "bot_token") ?? stringOption(options, "token");
  if (argvToken) {
    console.error("Warning: --bot-token exposes the token in shell history/process lists. Prefer --bot-token-file or --bot-token-stdin.");
  }
  return argvToken;
}

async function commandSetup(options) {
  const botToken = readBotTokenForSetup(options);
  const chatId = stringOption(options, "chat_id");
  const apiBase = stringOption(options, "api_base");
  const updates = {};

  if (botToken) updates.PI_TELEGRAM_BOT_TOKEN = botToken;
  if (chatId) updates.PI_TELEGRAM_CHAT_ID = chatId;
  if (apiBase) updates.PI_TELEGRAM_API_BASE = apiBase;

  if (Object.keys(updates).length === 0) {
    throw new Error("setup requires at least one of --bot-token-file, --bot-token-stdin, --chat-id, or --api-base. --bot-token is supported but not recommended.");
  }

  const path = globalDotEnvPath();
  if (options.dry_run) {
    const summary = { ok: true, dry_run: true, config_path: path, keys: Object.keys(updates) };
    maybePrintJson(options, summary);
    if (!options.json) console.log(`Dry run: would write ${Object.keys(updates).join(", ")} to ${path}.`);
    return;
  }

  writeDotEnvValues(path, updates);
  const summary = { ok: true, config_path: path, keys: Object.keys(updates) };
  maybePrintJson(options, summary);
  if (!options.json) console.log(`Updated Telegram config at ${path}.`);
}

function commandConfigPath(options) {
  const summary = { ok: true, config_path: globalDotEnvPath(), exists: existsSync(globalDotEnvPath()) };
  maybePrintJson(options, summary);
  if (!options.json) console.log(globalDotEnvPath());
}

function printHelp() {
  console.log(`pi-telegram - send one-way Telegram notifications from Pi or shell scripts

Usage:
  pi-telegram send-message --message <text> [--chat-id <id>] [--parse-mode HTML|MarkdownV2|Markdown] [--silent] [--json]
  pi-telegram send-message --message-file <path> [options]
  pi-telegram send-file --source <path-or-url-or-file-id> [--caption <text>] [--filename <name>] [options]
  pi-telegram send-image --source <path-or-url-or-file-id> [--caption <text>] [options]
  pi-telegram send-audio --source <path-or-url-or-file-id> [--caption <text>] [--title <title>] [--performer <name>] [--duration <seconds>] [options]
  pi-telegram setup --bot-token-file <path> --chat-id <id>
  printf '%s' "$BOT_TOKEN" | pi-telegram setup --bot-token-stdin --chat-id <id>
  pi-telegram config-path

Config lookup order:
  1. Environment variables: PI_TELEGRAM_BOT_TOKEN / PI_TELEGRAM_CHAT_ID / PI_TELEGRAM_API_BASE
  2. Project .env in the current working directory
  3. Global config: ~/.pi/agent/pi-telegram/.env

Common options:
  --chat-id <id>                  Override configured chat id for this send
  --parse-mode <mode>             HTML, MarkdownV2, or Markdown
  --disable-notification, --silent Send without notification sound
  --json                          Print machine-readable JSON summary
  --dry-run                       Validate inputs/config without sending

Examples:
  pi-telegram send-message --message "Build finished" --silent
  pi-telegram send-file --source ./app-release.apk --caption "Release APK" --json

Security:
  Prefer --bot-token-file or --bot-token-stdin for setup. Raw --bot-token is supported for automation,
  but can expose the token in shell history and process listings.
`);
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "send-message") return commandSendMessage(options);
  if (["send-file", "send-image", "send-audio"].includes(command)) return commandSendMedia(command, options);
  if (command === "setup") return commandSetup(options);
  if (command === "config-path") return commandConfigPath(options);

  throw new Error(`Unknown command '${command}'. Run 'pi-telegram --help'.`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`pi-telegram: ${error.message}`);
    process.exitCode = 1;
  });
}
