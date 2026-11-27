import { extname, isAbsolute } from 'node:path';
import type { Message } from '../shared/protocol';

export const limits = {
  /** Maximum file size accepted for extraction. */
  fileBytes: 20 * 1024 * 1024,
  /** Maximum number of PDF pages read. */
  pdfPages: 300,
  /** Maximum extracted characters per document and across all attachments. */
  attachmentCharacters: 60_000,
  /** Maximum number of attached documents. */
  attachments: 10,
  /** Maximum number of messages in one conversation. */
  messages: 100,
  /** Maximum total characters across conversation messages (excluding attachments). */
  conversationCharacters: 100_000,
};

const invalidRequest = () => new Error('Invalid chat request. Start a new chat and try again.');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates an untrusted chat request from the renderer and returns a clean copy. */
export function validateMessages(value: unknown): Message[] {
  if (!Array.isArray(value) || !value.length) throw invalidRequest();
  const messages = value.map((item): Message => {
    if (!isRecord(item)) throw invalidRequest();
    const { role, content } = item;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') throw invalidRequest();
    return { role, content };
  });
  if (messages.at(-1)!.role !== 'user') throw invalidRequest();
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  if (messages.length > limits.messages || characters > limits.conversationCharacters) {
    throw new Error('This conversation is too long. Start a new chat.');
  }
  return messages;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

/** Validates a file path received from the renderer before the main process opens it. */
export function validateAttachmentPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('Choose a PDF or TXT file saved on this computer.');
  }
  const extension = extname(value).toLowerCase();
  if (extension !== '.pdf' && extension !== '.txt') throw new Error('Drop a PDF or TXT file.');
  return value;
}

/** Links from model replies may only open in the system browser or mail client. */
export function isExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return true;
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Adds attached source material to the latest user message. */
export function withAttachments(messages: Message[], attachments: { name: string; text: string }[]): Message[] {
  if (!attachments.length) return messages;
  const request = [...messages];
  request[request.length - 1] = {
    role: 'user',
    content: 'Attached source material (JSON):\n' + JSON.stringify(attachments) + '\n\nUser request:\n' + request.at(-1)!.content,
  };
  return request;
}
