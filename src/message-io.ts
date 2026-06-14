import { createHash } from "node:crypto";

import { renderTemplate } from "./command.js";
import { expandPath } from "./paths.js";
import { runCommandAsync } from "./async-process.js";

export function parseMessageOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.messages)) return parsed.messages;
    return [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export function normalizeMessages(rawMessages) {
  return rawMessages.map((message, index) => normalizeMessage(message, index));
}

export function normalizeMessage(message, index = 0) {
  const text = String(message.text ?? message.message ?? message.body ?? "");
  const createdAt = message.createdAt ?? message.created_at ?? message.date ?? message.time ?? message.timestamp ?? "";
  const rawId = message.id ?? message.guid ?? message.messageId ?? message.message_id ?? message.rowid;
  const id = rawId === undefined || rawId === null || rawId === ""
    ? fallbackMessageId({ text, createdAt, index })
    : String(rawId);
  const direction = String(message.direction ?? message.type ?? "").toLowerCase();
  const rawFromMe = message.isFromMe ?? message.is_from_me ?? message.fromMe ?? message.from_me ?? message.fromSelf;
  const isFromMe = rawFromMe === undefined
    ? direction === "outgoing" || direction === "sent" || direction === "me"
    : Boolean(rawFromMe);

  return {
    raw: message,
    id,
    text,
    createdAt: String(createdAt || ""),
    sender: String(message.sender ?? message.from ?? message.handle ?? ""),
    isFromMe,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
  };
}

export function isIncomingUserMessage(message) {
  return Boolean(message && !message.isFromMe && (message.text?.trim() || message.attachments?.length));
}

export function formatIncomingForPrompt(messages) {
  const normalized = normalizeMessages(messages);
  if (normalized.length === 1) {
    const message = normalized[0];
    const attachments = formatAttachments(message.attachments);
    return `New incoming iMessage/SMS from the configured chat (${message.createdAt || "unknown time"}, message id ${message.id}).\n\n${message.text || "[no text]"}${attachments}\n\nReply directly and concisely as a text message. Do not mention daemon internals.`;
  }

  const body = normalized
    .map((message) => {
      const attachments = message.attachments?.length ? `\n  attachments: ${message.attachments.map(formatAttachment).join("; ")}` : "";
      return `- ${message.createdAt || "unknown time"} id=${message.id}: ${message.text || "[no text]"}${attachments}`;
    })
    .join("\n");
  return `The configured iMessage/SMS chat sent these new messages, in order:\n${body}\n\nRespond once, directly and concisely as a text message. Do not mention daemon internals.`;
}

export function splitMessage(text, maxChars = 1400) {
  const clean = String(text || "").trim() || "Done.";
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxChars) {
    let index = remaining.lastIndexOf("\n\n", maxChars);
    if (index < maxChars * 0.5) index = remaining.lastIndexOf("\n", maxChars);
    if (index < maxChars * 0.5) index = remaining.lastIndexOf(" ", maxChars);
    if (index < maxChars * 0.5) index = maxChars;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildAdapterArgv(commandConfig, context) {
  if (!commandConfig || !Array.isArray(commandConfig.argv) || commandConfig.argv.length === 0) {
    throw new Error("message command adapter must define a non-empty argv array");
  }
  return commandConfig.argv.map((part) => renderTemplate(part, context));
}

export async function receiveMessages(config) {
  const imessage = config.imessage || {};
  const receive = imessage.receive || {};
  if (receive.backend === "none" || receive.enabled === false) return [];
  if (receive.backend !== "command") throw new Error(`unsupported receive backend: ${receive.backend || "missing"}`);

  const commandConfig = receive.command || {};
  const argv = buildAdapterArgv(commandConfig, messageContext(config, { limit: imessage.syncLimit || 5 }));
  const result = await runCommandAsync(argv[0], argv.slice(1), {
    cwd: expandPath(commandConfig.cwd || "~"),
    timeoutMs: Number(commandConfig.timeoutMs || 30000),
    maxBuffer: Number(commandConfig.maxBufferBytes || 10 * 1024 * 1024),
  });
  return normalizeMessages(parseMessageOutput(result.stdout));
}

export async function sendMessage(config: any, text: string, io: any = process) {
  const imessage = config.imessage || {};
  const send = imessage.send || {};
  const maxReplyChars = Number(imessage.maxReplyChars || 1400);
  const chunks = splitMessage(text, maxReplyChars);

  if (send.backend === "none" || send.enabled === false) {
    for (const chunk of chunks) {
      io.stdout?.write?.(`[relaymux send disabled] ${chunk}\n`);
    }
    return;
  }
  if (send.backend !== "command") throw new Error(`unsupported send backend: ${send.backend || "missing"}`);

  const commandConfig = send.command || {};
  for (const chunk of chunks) {
    const argv = buildAdapterArgv(commandConfig, messageContext(config, { text: commandSafeMessageText(chunk) }));
    await runCommandAsync(argv[0], argv.slice(1), {
      cwd: expandPath(commandConfig.cwd || "~"),
      timeoutMs: Number(commandConfig.timeoutMs || 60000),
      maxBuffer: Number(commandConfig.maxBufferBytes || 10 * 1024 * 1024),
    });
  }
}

export function commandSafeMessageText(text) {
  const value = String(text || "");
  // imsg 0.8.x does not accept option values that start with "-" when they are
  // passed as the argv element after --text. Prefix an invisible character so
  // bullet-list replies like "- fixed X" do not get parsed as more flags.
  return value.startsWith("-") ? `\u200B${value}` : value;
}

export function messageContext(config, extra = {}) {
  const imessage = config.imessage || {};
  return {
    chatId: imessage.chatId || "",
    recipient: imessage.recipient || "",
    limit: imessage.syncLimit || 5,
    text: "",
    ...extra,
  };
}

function fallbackMessageId({ text, createdAt, index }) {
  const hash = createHash("sha256").update(`${createdAt}\0${text}\0${index}`).digest("hex").slice(0, 16);
  return `msg-${hash}`;
}

function formatAttachments(attachments) {
  return attachments?.length
    ? `\nAttachments:\n${attachments.map((attachment) => `- ${formatAttachment(attachment)}`).join("\n")}`
    : "";
}

function formatAttachment(attachment) {
  const fields = [];
  for (const key of ["filename", "name", "mime_type", "mimeType", "uti", "path", "cached_path", "url"]) {
    if (attachment?.[key]) fields.push(`${key}=${attachment[key]}`);
  }
  return fields.length ? fields.join(" ") : JSON.stringify(attachment);
}
