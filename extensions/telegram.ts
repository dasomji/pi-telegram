import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

type TelegramConfig = {
  botToken: string;
  chatId?: string;
  apiBase: string;
};

type TelegramSendParams = {
  message: string;
  chat_id?: string;
  parse_mode?: string;
  disable_notification?: boolean;
};

type TelegramMediaParams = {
  source: string;
  caption?: string;
  chat_id?: string;
  parse_mode?: string;
  disable_notification?: boolean;
};

type TelegramAudioParams = TelegramMediaParams & {
  duration?: number;
  performer?: string;
  title?: string;
};

type TelegramFileParams = TelegramMediaParams & {
  filename?: string;
  disable_content_type_detection?: boolean;
};

type TelegramChat = {
  id: number | string;
  type?: string;
  username?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessageResult = {
  message_id?: number;
  chat?: TelegramChat;
};

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: { chat?: TelegramChat };
  edited_message?: { chat?: TelegramChat };
  channel_post?: { chat?: TelegramChat };
  edited_channel_post?: { chat?: TelegramChat };
  my_chat_member?: { chat?: TelegramChat };
};

type TelegramApiResponse<TResult = TelegramMessageResult> = {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: TResult;
};

function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

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

function projectDotEnvPath(cwd: string): string {
  return join(cwd, ".env");
}

function globalConfigDir(): string {
  return process.env[GLOBAL_CONFIG_DIR_ENV]?.trim() || join(homedir(), ".pi", "agent", "pi-telegram");
}

function globalDotEnvPath(): string {
  return join(globalConfigDir(), ".env");
}

function loadDotEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, "utf8"));
}

function loadProjectDotEnv(cwd?: string): Record<string, string> {
  if (!cwd) return {};
  return loadDotEnvFile(projectDotEnvPath(cwd));
}

function withoutBlankValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim().length > 0));
}

function loadConfigDotEnv(cwd?: string): Record<string, string> {
  return {
    ...withoutBlankValues(loadDotEnvFile(globalDotEnvPath())),
    ...withoutBlankValues(loadProjectDotEnv(cwd)),
  };
}

function formatDotEnvValue(value: string): string {
  if (/^[A-Za-z0-9_:@./+=-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function writeDotEnvValues(path: string, updates: Record<string, string>): void {
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

function firstConfigValue(dotEnv: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = (process.env[name] ?? dotEnv[name])?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveConfig(cwd?: string): TelegramConfig {
  const dotEnv = loadConfigDotEnv(cwd);

  return {
    botToken: firstConfigValue(dotEnv, "PI_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN") ?? "",
    chatId: firstConfigValue(dotEnv, "PI_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"),
    apiBase: (firstConfigValue(dotEnv, "PI_TELEGRAM_API_BASE", "TELEGRAM_API_BASE") ?? DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, ""),
  };
}

export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (limit < 1) throw new Error("Telegram message split limit must be positive.");

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new Error("Telegram message text must not be empty.");

  const chunks: string[] = [];
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

function validateChatAndParseMode(
  params: { chat_id?: string; parse_mode?: string },
  config: TelegramConfig,
): { chatId: string; parseMode?: string } {
  if (!config.botToken) {
    throw new Error(
      "Telegram is not configured: set PI_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) to your BotFather token.",
    );
  }

  const chatId = params.chat_id?.trim() || config.chatId;
  if (!chatId) {
    throw new Error(
      "Telegram chat is not configured: set PI_TELEGRAM_CHAT_ID (or TELEGRAM_CHAT_ID), or pass chat_id to the Telegram tool.",
    );
  }

  const parseMode = params.parse_mode?.trim();
  if (parseMode && !ALLOWED_PARSE_MODES.has(parseMode)) {
    throw new Error(`Unsupported Telegram parse_mode '${parseMode}'. Use HTML, MarkdownV2, Markdown, or omit parse_mode for plain text.`);
  }

  return { chatId, parseMode };
}

function validateTextParams(params: TelegramSendParams, config: TelegramConfig): { chatId: string; parseMode?: string } {
  if (params.message.length > MAX_REQUEST_TEXT_LENGTH) {
    throw new Error(`Telegram message is too long (${params.message.length} chars). Keep it under ${MAX_REQUEST_TEXT_LENGTH} chars.`);
  }

  return validateChatAndParseMode(params, config);
}

function validateCaption(caption: string | undefined): string | undefined {
  const trimmed = caption?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > TELEGRAM_CAPTION_LIMIT) {
    throw new Error(`Telegram media caption is too long (${trimmed.length} chars). Keep it under ${TELEGRAM_CAPTION_LIMIT} chars.`);
  }
  return trimmed;
}

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function resolveLocalSource(source: string, cwd: string): string | undefined {
  if (isHttpUrl(source)) return undefined;

  const resolved = resolve(cwd, source);
  if (!existsSync(resolved)) return undefined;

  const stats = statSync(resolved);
  if (!stats.isFile()) throw new Error(`Telegram media source is not a file: ${source}`);
  return resolved;
}

function mimeTypeForPath(path: string, kind: "photo" | "audio" | "document"): string {
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
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

function buildJsonBody(fields: Record<string, string | number | boolean | undefined>): string {
  const body: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body[key] = value;
  }
  return JSON.stringify(body);
}

function buildMultipartBody(
  fields: Record<string, string | number | boolean | undefined>,
  media: { fieldName: string; filePath: string; kind: "photo" | "audio" | "document"; filename?: string },
): FormData {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }

  const fileBytes = readFileSync(media.filePath);
  const blob = new Blob([fileBytes], { type: mimeTypeForPath(media.filePath, media.kind) });
  form.append(media.fieldName, blob, media.filename?.trim() || basename(media.filePath));

  return form;
}

async function callTelegramApi<TResult = TelegramMessageResult>(
  config: TelegramConfig,
  method: string,
  body: string | FormData,
  signal?: AbortSignal,
): Promise<TelegramApiResponse<TResult>> {
  const headers = typeof body === "string" ? { "content-type": "application/json" } : undefined;
  const response = await fetch(`${config.apiBase}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers,
    body,
    signal,
  });

  const responseBody = await response.text();
  let payload: TelegramApiResponse<TResult>;
  try {
    payload = JSON.parse(responseBody) as TelegramApiResponse<TResult>;
  } catch {
    throw new Error(`Telegram API returned non-JSON response with HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
  }

  if (!response.ok || !payload.ok) {
    const reason = payload.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API ${method} failed${payload.error_code ? ` (${payload.error_code})` : ""}: ${reason}`);
  }

  return payload;
}

async function sendTelegramChunk(
  config: TelegramConfig,
  chunk: string,
  options: { chatId: string; parseMode?: string; disableNotification?: boolean; signal?: AbortSignal },
): Promise<TelegramApiResponse> {
  return callTelegramApi(
    config,
    "sendMessage",
    buildJsonBody({
      chat_id: options.chatId,
      text: chunk,
      parse_mode: options.parseMode,
      disable_notification: options.disableNotification,
    }),
    options.signal,
  );
}

async function getTelegramBot(config: TelegramConfig): Promise<TelegramUser> {
  if (!config.botToken) {
    throw new Error("Telegram bot token is missing.");
  }

  const payload = await callTelegramApi<TelegramUser>(config, "getMe", buildJsonBody({}));
  if (!payload.result) throw new Error("Telegram getMe returned no bot information.");
  return payload.result;
}

async function getTelegramUpdates(config: TelegramConfig): Promise<TelegramUpdate[]> {
  const payload = await callTelegramApi<TelegramUpdate[]>(config, "getUpdates", buildJsonBody({ timeout: 10 }));
  return payload.result ?? [];
}

function chatFromUpdate(update: TelegramUpdate): TelegramChat | undefined {
  return (
    update.message?.chat ??
    update.edited_message?.chat ??
    update.channel_post?.chat ??
    update.edited_channel_post?.chat ??
    update.my_chat_member?.chat
  );
}

function latestChatFromUpdates(updates: TelegramUpdate[]): TelegramChat | undefined {
  for (const update of [...updates].sort((a, b) => b.update_id - a.update_id)) {
    const chat = chatFromUpdate(update);
    if (chat?.id !== undefined) return chat;
  }
  return undefined;
}

function displayBotTarget(bot: TelegramUser): string {
  return bot.username ? `@${bot.username}` : bot.first_name;
}

async function sendTelegramMedia(
  config: TelegramConfig,
  method: "sendPhoto" | "sendAudio" | "sendDocument",
  params: TelegramMediaParams | TelegramAudioParams | TelegramFileParams,
  options: { cwd: string; mediaField: "photo" | "audio" | "document"; maxBytes: number; signal?: AbortSignal },
): Promise<TelegramApiResponse> {
  const { chatId, parseMode } = validateChatAndParseMode(params, config);
  const source = normalizeSource(params.source);
  const caption = validateCaption(params.caption);
  const localPath = resolveLocalSource(source, options.cwd);

  const fields: Record<string, string | number | boolean | undefined> = {
    chat_id: chatId,
    caption,
    parse_mode: parseMode,
    disable_notification: params.disable_notification,
  };

  if (method === "sendAudio") {
    const audioParams = params as TelegramAudioParams;
    fields.duration = audioParams.duration;
    fields.performer = audioParams.performer;
    fields.title = audioParams.title;
  }

  if (method === "sendDocument") {
    fields.disable_content_type_detection = (params as TelegramFileParams).disable_content_type_detection;
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
        filename: (params as TelegramFileParams).filename,
      }),
      options.signal,
    );
  }

  return callTelegramApi(
    config,
    method,
    buildJsonBody({ ...fields, [options.mediaField]: source }),
    options.signal,
  );
}

const telegramSendMessageTool = defineTool({
  name: "telegram_send_message",
  label: "Telegram Notify",
  description:
    "Send a one-way text notification or report from Pi to the user's configured Telegram chat via a BotFather bot. Does not read Telegram replies.",
  promptSnippet: "Send a one-way Telegram notification/report to the configured user chat.",
  promptGuidelines: [
    "Use telegram_send_message when the user asks Pi to notify them, send a report, or send status updates via Telegram.",
    "Do not use telegram_send_message for clarification questions or two-way conversation; Telegram support is one-way from agent to user.",
    "Keep telegram_send_message content concise and never include secrets, API keys, bot tokens, or private credentials.",
  ],
  parameters: Type.Object({
    message: Type.String({
      description: "Plain text message/report to send. Long text is split into Telegram-sized chunks automatically.",
      minLength: 1,
      maxLength: MAX_REQUEST_TEXT_LENGTH,
    }),
    chat_id: Type.Optional(
      Type.String({
        description:
          "Optional Telegram chat id or @channelusername. Defaults to PI_TELEGRAM_CHAT_ID/TELEGRAM_CHAT_ID when omitted.",
      }),
    ),
    parse_mode: Type.Optional(
      Type.String({
        description: "Optional Telegram parse mode: HTML, MarkdownV2, or Markdown. Omit for safest plain text delivery.",
      }),
    ),
    disable_notification: Type.Optional(
      Type.Boolean({ description: "If true, Telegram sends the message silently without notification sound." }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const config = resolveConfig(ctx.cwd);
    const { chatId, parseMode } = validateTextParams(params, config);
    const chunks = splitTelegramMessage(params.message, TELEGRAM_SAFE_CHUNK_LIMIT);
    const messageIds: Array<number | undefined> = [];

    for (const [index, chunk] of chunks.entries()) {
      const text = chunks.length === 1 ? chunk : `(${index + 1}/${chunks.length})\n${chunk}`;
      const payload = await sendTelegramChunk(config, text, {
        chatId,
        parseMode,
        disableNotification: params.disable_notification,
        signal,
      });
      messageIds.push(payload.result?.message_id);
    }

    const summary = `Sent ${chunks.length} Telegram message${chunks.length === 1 ? "" : "s"} to ${chatId}.`;
    return {
      content: [{ type: "text", text: summary }],
      details: {
        chatId,
        chunksSent: chunks.length,
        messageIds,
        parseMode: parseMode ?? "plain",
        disableNotification: Boolean(params.disable_notification),
      },
    };
  },
});

const telegramSendImageTool = defineTool({
  name: "telegram_send_image",
  label: "Telegram Image",
  description:
    "Send a one-way image/photo file to the user's configured Telegram chat. Accepts a local file path, HTTP(S) URL, or Telegram file_id. Does not read Telegram replies.",
  promptSnippet: "Send an image/photo file to the configured Telegram chat.",
  promptGuidelines: [
    "Use telegram_send_image when the user asks Pi to send an image, screenshot, diagram, visual report, or generated image via Telegram.",
    "Before using telegram_send_image with a local file, make sure the file exists and is the intended image; do not send unrelated private images.",
    "Do not use telegram_send_image for two-way conversation; Telegram support is one-way from agent to user.",
  ],
  parameters: Type.Object({
    source: Type.String({
      description: "Local image path relative to Pi's current working directory, absolute image path, HTTP(S) URL, or Telegram file_id.",
      minLength: 1,
    }),
    caption: Type.Optional(Type.String({ description: "Optional image caption, max 1024 characters.", maxLength: TELEGRAM_CAPTION_LIMIT })),
    chat_id: Type.Optional(Type.String({ description: "Optional Telegram chat id or @channelusername. Defaults to configured chat id." })),
    parse_mode: Type.Optional(Type.String({ description: "Optional caption parse mode: HTML, MarkdownV2, or Markdown. Omit for plain text." })),
    disable_notification: Type.Optional(Type.Boolean({ description: "If true, Telegram sends the image silently." })),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const config = resolveConfig(ctx.cwd);
    const payload = await sendTelegramMedia(config, "sendPhoto", params, {
      cwd: ctx.cwd,
      mediaField: "photo",
      maxBytes: TELEGRAM_PHOTO_MAX_BYTES,
      signal,
    });

    return {
      content: [{ type: "text", text: `Sent Telegram image to ${payload.result?.chat?.id ?? params.chat_id ?? "configured chat"}.` }],
      details: {
        chatId: payload.result?.chat?.id ?? params.chat_id,
        messageId: payload.result?.message_id,
        source: params.source,
        caption: params.caption,
      },
    };
  },
});

const telegramSendFileTool = defineTool({
  name: "telegram_send_file",
  label: "Telegram File",
  description:
    "Send a one-way general file/document to the user's configured Telegram chat. Useful for APKs, app bundles, logs, reports, ZIPs, PDFs, and other build artifacts. Does not read Telegram replies.",
  promptSnippet: "Send a general file/document to the configured Telegram chat.",
  promptGuidelines: [
    "Use telegram_send_file when the user asks Pi to send an APK, Android app bundle, log file, report, ZIP/PDF, or other build artifact via Telegram.",
    "Before using telegram_send_file with a local file, make sure the file exists and is the intended artifact; do not send unrelated private files.",
    "Do not send secrets, API keys, signing keys, keystores, credential files, or private environment files via Telegram.",
    "Prefer local file paths for arbitrary files. Telegram only supports fetching some document types by HTTP URL.",
    "Do not use telegram_send_file for two-way conversation; Telegram support is one-way from agent to user.",
  ],
  parameters: Type.Object({
    source: Type.String({
      description:
        "Local file path relative to Pi's current working directory, absolute file path, HTTP(S) URL, or Telegram file_id. Local files are uploaded as documents.",
      minLength: 1,
    }),
    caption: Type.Optional(Type.String({ description: "Optional file caption, max 1024 characters.", maxLength: TELEGRAM_CAPTION_LIMIT })),
    filename: Type.Optional(Type.String({ description: "Optional display filename for local file uploads." })),
    chat_id: Type.Optional(Type.String({ description: "Optional Telegram chat id or @channelusername. Defaults to configured chat id." })),
    parse_mode: Type.Optional(Type.String({ description: "Optional caption parse mode: HTML, MarkdownV2, or Markdown. Omit for plain text." })),
    disable_notification: Type.Optional(Type.Boolean({ description: "If true, Telegram sends the file silently." })),
    disable_content_type_detection: Type.Optional(
      Type.Boolean({ description: "If true, disables Telegram's server-side content type detection for uploaded files." }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const config = resolveConfig(ctx.cwd);
    const payload = await sendTelegramMedia(config, "sendDocument", params, {
      cwd: ctx.cwd,
      mediaField: "document",
      maxBytes: TELEGRAM_DOCUMENT_MAX_BYTES,
      signal,
    });

    return {
      content: [{ type: "text", text: `Sent Telegram file to ${payload.result?.chat?.id ?? params.chat_id ?? "configured chat"}.` }],
      details: {
        chatId: payload.result?.chat?.id ?? params.chat_id,
        messageId: payload.result?.message_id,
        source: params.source,
        caption: params.caption,
        filename: params.filename,
        disableContentTypeDetection: Boolean(params.disable_content_type_detection),
      },
    };
  },
});

const telegramSendAudioTool = defineTool({
  name: "telegram_send_audio",
  label: "Telegram Audio",
  description:
    "Send a one-way audio file to the user's configured Telegram chat. Accepts a local file path, HTTP(S) URL, or Telegram file_id. Does not read Telegram replies.",
  promptSnippet: "Send an audio file to the configured Telegram chat.",
  promptGuidelines: [
    "Use telegram_send_audio when the user asks Pi to send an audio file, music file, recording, or generated audio via Telegram.",
    "Before using telegram_send_audio with a local file, make sure the file exists and is the intended audio; do not send unrelated private recordings.",
    "Do not use telegram_send_audio for two-way conversation; Telegram support is one-way from agent to user.",
  ],
  parameters: Type.Object({
    source: Type.String({
      description: "Local audio path relative to Pi's current working directory, absolute audio path, HTTP(S) URL, or Telegram file_id.",
      minLength: 1,
    }),
    caption: Type.Optional(Type.String({ description: "Optional audio caption, max 1024 characters.", maxLength: TELEGRAM_CAPTION_LIMIT })),
    title: Type.Optional(Type.String({ description: "Optional track title shown by Telegram clients." })),
    performer: Type.Optional(Type.String({ description: "Optional performer/artist shown by Telegram clients." })),
    duration: Type.Optional(Type.Number({ description: "Optional audio duration in seconds." })),
    chat_id: Type.Optional(Type.String({ description: "Optional Telegram chat id or @channelusername. Defaults to configured chat id." })),
    parse_mode: Type.Optional(Type.String({ description: "Optional caption parse mode: HTML, MarkdownV2, or Markdown. Omit for plain text." })),
    disable_notification: Type.Optional(Type.Boolean({ description: "If true, Telegram sends the audio silently." })),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const config = resolveConfig(ctx.cwd);
    const payload = await sendTelegramMedia(config, "sendAudio", params, {
      cwd: ctx.cwd,
      mediaField: "audio",
      maxBytes: TELEGRAM_AUDIO_MAX_BYTES,
      signal,
    });

    return {
      content: [{ type: "text", text: `Sent Telegram audio to ${payload.result?.chat?.id ?? params.chat_id ?? "configured chat"}.` }],
      details: {
        chatId: payload.result?.chat?.id ?? params.chat_id,
        messageId: payload.result?.message_id,
        source: params.source,
        caption: params.caption,
        title: params.title,
        performer: params.performer,
        duration: params.duration,
      },
    };
  },
});

export default function piTelegramExtension(pi: ExtensionAPI) {
  pi.registerTool(telegramSendMessageTool);
  pi.registerTool(telegramSendImageTool);
  pi.registerTool(telegramSendFileTool);
  pi.registerTool(telegramSendAudioTool);

  pi.registerCommand("setup-telegram-token", {
    description: "Configure Telegram BotFather token and chat id in a global Pi Telegram .env file without sending the token to the LLM.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("/setup-telegram-token requires interactive UI so the token is not sent through the LLM chat.");
      }

      const existingConfig = resolveConfig(ctx.cwd);
      const tokenPrompt = existingConfig.botToken
        ? "Telegram bot token (leave blank to keep the existing .env token):"
        : "Telegram bot token from BotFather:";
      const enteredToken = await ctx.ui.input(tokenPrompt, existingConfig.botToken ? "leave blank to keep existing" : "123456:ABC...");
      if (enteredToken === undefined) {
        ctx.ui.notify("Telegram setup cancelled.", "warning");
        return;
      }

      const enteredTokenTrimmed = enteredToken.trim();
      const botToken = enteredTokenTrimmed || existingConfig.botToken;
      const tokenChanged = Boolean(enteredTokenTrimmed) && enteredTokenTrimmed !== existingConfig.botToken;
      if (!botToken) {
        ctx.ui.notify("Telegram setup cancelled: no bot token provided.", "warning");
        return;
      }

      const configWithToken: TelegramConfig = {
        ...existingConfig,
        botToken,
      };
      const bot = await getTelegramBot(configWithToken);
      const botTarget = displayBotTarget(bot);

      const configPath = globalDotEnvPath();
      writeDotEnvValues(
        configPath,
        tokenChanged ? { PI_TELEGRAM_BOT_TOKEN: botToken, PI_TELEGRAM_CHAT_ID: "" } : { PI_TELEGRAM_BOT_TOKEN: botToken },
      );
      ctx.ui.notify(`Saved Telegram bot token for ${botTarget} to ${configPath}.`, "info");

      const confirmation = await ctx.ui.input(
        `Send any message (for example "hello world") to ${botTarget}, then press Enter here:`,
        "press Enter after messaging the bot",
      );
      if (confirmation === undefined) {
        ctx.ui.notify("Telegram token saved; chat id discovery skipped.", "warning");
        return;
      }

      const updates = await getTelegramUpdates(configWithToken);
      const chat = latestChatFromUpdates(updates);
      if (!chat) {
        ctx.ui.notify(`No Telegram chat id found yet. Send a message to ${botTarget}, then run /setup-telegram-token again.`, "error");
        return;
      }

      const chatId = String(chat.id);
      const finalConfig: TelegramConfig = { ...configWithToken, chatId };
      writeDotEnvValues(configPath, { PI_TELEGRAM_BOT_TOKEN: botToken, PI_TELEGRAM_CHAT_ID: chatId });

      await sendTelegramChunk(finalConfig, "Pi Telegram setup complete. One-way notifications are working.", { chatId });
      ctx.ui.notify(`Saved Telegram chat id ${chatId} to ${configPath} and sent a setup confirmation.`, "info");
    },
  });
}
