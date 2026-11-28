import { app } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isRecord, limits } from './validation';
import type { History, HistoryAttachment, StoredMessage, WebSource } from '../shared/protocol';

export const historyPath = () => join(app.getPath('userData'), 'history.json');

const maxMessages = limits.messages;
const maxContent = limits.conversationCharacters;
const maxAttachments = limits.attachments;
const maxName = 256;

let queue: Promise<void> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

/** Writes `content` atomically: a temp file is renamed into place so a crash mid-write leaves the old file intact. */
export async function atomicWrite(file: string, content: string) {
  await rm(file + '.tmp', { force: true }).catch(() => {});
  await writeFile(file + '.tmp', content, { mode: 0o600 });
  await rename(file + '.tmp', file);
}

function parseMessage(value: unknown): StoredMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { id, role, content, sources } = value;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.length > maxContent) return undefined;
  const safeId = typeof id === 'string' && id.length <= 100 ? id : randomUUID();
  let safeSources: WebSource[] | undefined;
  if (Array.isArray(sources)) {
    safeSources = [];
    for (const item of sources) {
      if (isRecord(item) && typeof item.url === 'string' && item.url.length <= 2048 &&
          typeof item.title === 'string' && item.title.length <= 200) {
        safeSources.push({ url: item.url, title: item.title });
      }
    }
    if (!safeSources.length) safeSources = undefined;
  }
  return { id: safeId, role, content, ...(safeSources ? { sources: safeSources } : {}) };
}

function parseAttachment(value: unknown): HistoryAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const { name, characters, excerpted } = value;
  if (typeof name !== 'string' || !name.trim() || name.length > maxName) return undefined;
  const chars = typeof characters === 'number' && Number.isFinite(characters) && characters >= 0 ? Math.floor(characters) : 0;
  return { name: name.trim(), characters: chars, ...(excerpted === true ? { excerpted: true } : {}) };
}

/**
 * Normalizes untrusted history JSON into a safe `History`. Missing or malformed fields are dropped,
 * and a history with neither messages nor attachments is treated as "nothing to restore".
 */
export function parseHistory(value: unknown): History | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.messages)) return undefined;
  const messages = value.messages.map(parseMessage).filter((message): message is StoredMessage => Boolean(message));
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(parseAttachment).filter((item): item is HistoryAttachment => Boolean(item)).slice(0, maxAttachments)
    : [];
  if (!messages.length && !attachments.length) return undefined;
  const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : Date.now();
  return { version: 1, savedAt, messages: messages.slice(-maxMessages), attachments };
}

/** Reads the saved conversation, or null when none exists or the file is unreadable. */
export function loadHistory(): Promise<History | null> {
  return withLock(async () => {
    const file = historyPath();
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null; // An unreadable history is non-fatal; start a fresh session instead.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return parseHistory(parsed) ?? null;
  });
}

/** Persists the conversation. An empty history (no messages, no attachments) deletes the file instead. */
export function saveHistory(input: History): Promise<void> {
  return withLock(async () => {
    const history = parseHistory(input);
    const file = historyPath();
    if (!history || (!history.messages.length && !history.attachments.length)) {
      await rm(file, { force: true }).catch(() => {});
      return;
    }
    await mkdir(dirname(file), { recursive: true }).catch(() => {});
    await atomicWrite(file, JSON.stringify(history));
  });
}

/** Removes any saved conversation. */
export function clearHistory(): Promise<void> {
  return withLock(async () => {
    await rm(historyPath(), { force: true }).catch(() => {});
  });
}
