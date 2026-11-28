import { extname, isAbsolute } from 'node:path';
import {
  conversationLimits, supportedExtensions, textExtensions, type Message,
} from '../shared/protocol';

export const limits = {
  /** Maximum file size accepted for extraction. */
  fileBytes: 20 * 1024 * 1024,
  /** Maximum number of PDF pages read. */
  pdfPages: 300,
  /** Maximum attachment characters included directly in a single model prompt. */
  attachmentCharacters: 60_000,
  /** Maximum extracted characters accepted from a single document. */
  documentCharacters: 300_000,
  /** Maximum extracted characters retained across all attached documents. */
  totalAttachmentCharacters: 600_000,
  /** Maximum number of attached documents. */
  attachments: 10,
  /** Maximum number of messages in one conversation request. */
  messages: conversationLimits.messages,
  /** Maximum total characters across conversation messages (excluding attachments). */
  conversationCharacters: conversationLimits.characters,
  /** Maximum characters accepted from a single streamed model response. */
  streamCharacters: 500_000,
};

const supportedSet = new Set<string>(supportedExtensions);
const textSet = new Set<string>(textExtensions);

const invalidRequest = () => new Error('Invalid chat request. Start a new chat and try again.');

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSupportedExtension(filePath: string): boolean {
  return supportedSet.has(extname(filePath).toLowerCase());
}

export function isTextExtension(filePath: string): boolean {
  return textSet.has(extname(filePath).toLowerCase());
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
  const latest = messages.at(-1)!;
  if (latest.role !== 'user' || !latest.content.trim()) throw invalidRequest();
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
    throw new Error('Choose a PDF or text file saved on this computer.');
  }
  if (!isSupportedExtension(value)) {
    throw new Error('Drop a PDF or supported text file (.txt, .md, .csv, .json, .bib, .tex).');
  }
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

function splitSections(text: string, maxChunk = 2_400): string[] {
  const blocks = text.includes('\n\nPage ')
    ? text.split(/\n\n(?=Page \d+\n)/)
    : text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (!block) continue;
    if (block.length > maxChunk) {
      if (current) { chunks.push(current); current = ''; }
      for (let offset = 0; offset < block.length; offset += maxChunk) {
        chunks.push(block.slice(offset, offset + maxChunk));
      }
    } else if (current && current.length + 2 + block.length > maxChunk) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? current + '\n\n' + block : block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function extractTerms(query: string): string[] {
  const matches = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(matches)].slice(0, 40);
}

/** Selects up to `budget` characters of the most query-relevant sections in document order. */
export function excerptDocument(text: string, query: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return '';
  const chunks = splitSections(text, Math.min(2_400, Math.max(400, Math.floor(budget / 3))));
  if (chunks.length <= 1) return text.slice(0, budget);

  const terms = extractTerms(query);
  const pageNumbers = new Set((query.match(/\bpage\s+(\d+)\b/gi) ?? []).map(match => match.replace(/\D+/g, '')));
  const docFreq = new Map<string, number>();
  const lowerChunks = chunks.map(chunk => chunk.toLowerCase());
  for (const term of terms) {
    let count = 0;
    for (const lower of lowerChunks) if (lower.includes(term)) count++;
    if (count > 0) docFreq.set(term, count);
  }

  const scored = chunks.map((chunk, index) => {
    const lower = lowerChunks[index];
    let score = index === 0 ? 1_000_000 : 0; // Always include the opening overview/abstract first.
    const pageMatch = /^Page (\d+)\n/.exec(chunk);
    if (pageMatch && pageNumbers.has(pageMatch[1])) score += 500_000;
    for (const term of terms) {
      const df = docFreq.get(term);
      if (!df || !lower.includes(term)) continue;
      let occurrences = 0;
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1 && occurrences < 6) {
        occurrences++;
        pos += term.length;
      }
      score += occurrences * Math.log(1 + chunks.length / df);
    }
    return { index, chunk, score };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = new Set<number>();
  let used = 0;
  const separator = '\n\n[…]\n\n';
  for (const candidate of scored) {
    const overhead = picked.size === 0 ? 0 : separator.length;
    if (used + overhead + candidate.chunk.length > budget) {
      if (picked.size === 0) return candidate.chunk.slice(0, budget);
      continue;
    }
    picked.add(candidate.index);
    used += overhead + candidate.chunk.length;
  }

  const ordered = [...picked].sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < ordered.length; i++) {
    const idx = ordered[i];
    if (i > 0) out += ordered[i - 1] + 1 === idx ? '\n\n' : separator;
    out += chunks[idx];
  }
  return out;
}

/**
 * Injects attached source material into the conversation.
 * When all attachments fit within `limits.attachmentCharacters`, places them on the first user
 * message so the conversation prefix stays identical across follow-up turns (preserving KV/prompt caches).
 * When attachments exceed `limits.attachmentCharacters`, selects query-relevant excerpts within budget.
 */
export function withAttachments(
  messages: Message[],
  attachments: { name: string; text: string }[],
  budget = limits.attachmentCharacters,
): Message[] {
  if (!attachments.length || !messages.length) return messages;
  const total = attachments.reduce((sum, item) => sum + item.text.length, 0);
  const request = [...messages];

  if (total <= budget) {
    const firstUser = request.findIndex(message => message.role === 'user');
    const target = firstUser >= 0 ? firstUser : request.length - 1;
    request[target] = {
      role: 'user',
      content: 'Attached source material (JSON):\n' + JSON.stringify(attachments) + '\n\nUser request:\n' + request[target].content,
    };
    return request;
  }

  const query = messages.filter(message => message.role === 'user').slice(-2).map(message => message.content).join('\n');
  const minPerDoc = Math.min(2_000, Math.floor(budget / attachments.length));
  const allocations = attachments.map(item => Math.max(minPerDoc, Math.floor((item.text.length / total) * budget)));
  const allocatedSum = allocations.reduce((sum, value) => sum + value, 0);
  if (allocatedSum > budget) {
    const scale = budget / allocatedSum;
    for (let i = 0; i < allocations.length; i++) allocations[i] = Math.floor(allocations[i] * scale);
  }

  const excerpted = attachments.map((item, index) => {
    const sliceBudget = allocations[index];
    if (item.text.length <= sliceBudget) return item;
    return { name: item.name, excerpted: true, text: excerptDocument(item.text, query, sliceBudget) };
  });

  const lastIndex = request.length - 1;
  request[lastIndex] = {
    role: 'user',
    content: 'Attached source material excerpts (JSON):\n' + JSON.stringify(excerpted) + '\n\nUser request:\n' + request[lastIndex].content,
  };
  return request;
}
