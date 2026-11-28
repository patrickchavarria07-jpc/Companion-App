import type { Message, WebSource } from '../shared/protocol';
import { isExternalUrl, isRecord } from './validation';

export type SearchResult = WebSource & { excerpt: string };
const maxResults = 5;
export const maxSearchQueryLength = 400;

const followUpPattern = /^(and|also|what about|how about|or|why|when|where|who)\b|\b(it|its|they|them|their|that|those|this|these|same|above|earlier|previous)\b/i;

function clipWords(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const sliced = text.slice(0, limit);
  const boundary = sliced.lastIndexOf(' ');
  return (boundary > limit * 0.6 ? sliced.slice(0, boundary) : sliced).trim();
}

/**
 * Builds a concise `<= 400`-character Tavily query from the conversation:
 * - enriches short follow-up questions with the prior user topic;
 * - condenses long (>400 char) pasted passages while keeping any trailing question intact.
 */
export function buildSearchQuery(messages: Message[]): string {
  const raw = messages.at(-1)?.content.trim().replace(/\s+/g, ' ') ?? '';
  if (!raw) throw new Error('Enter a question before searching the web.');

  if (raw.length > maxSearchQueryLength) {
    const questionMatch = /([^.?!]{10,220}\?)\s*$/.exec(raw);
    if (questionMatch) {
      const question = questionMatch[1].trim();
      const headBudget = maxSearchQueryLength - question.length - 3;
      if (headBudget >= 40) return `${clipWords(raw.slice(0, raw.length - question.length).trim(), headBudget)} — ${question}`;
    }
    return clipWords(raw, maxSearchQueryLength);
  }

  if (messages.length > 1 && raw.length < 320 && followUpPattern.test(raw)) {
    const priorUsers = messages.slice(0, -1).filter(message => message.role === 'user');
    const prior = priorUsers.at(-1)?.content.trim().replace(/\s+/g, ' ');
    const topicBudget = Math.min(140, maxSearchQueryLength - raw.length - 3);
    if (prior && topicBudget >= 20) {
      return `${clipWords(prior, topicBudget)} — ${raw}`;
    }
  }

  return raw;
}

export async function searchWeb(query: string, signal: AbortSignal, apiKey?: string): Promise<SearchResult[]> {
  const key = (apiKey ?? process.env.TAVILY_API_KEY)?.trim();
  if (!key) {
    throw new Error('Add a Tavily API key in Settings (or set TAVILY_API_KEY) to use web search.');
  }
  if (!/^[!-~]+$/.test(key)) throw new Error('TAVILY_API_KEY contains invalid characters.');
  const trimmed = query.trim();
  if (!trimmed) throw new Error('Enter a question before searching the web.');
  if (trimmed.length > maxSearchQueryLength) {
    throw new Error('Keep your web search question to 400 characters or fewer.');
  }

  const timeout = AbortSignal.timeout(12_000);
  let data: unknown;
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        query: trimmed,
        search_depth: 'basic',
        max_results: maxResults,
        auto_parameters: false,
        include_published_date: true,
      }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new Error('Tavily rejected access. Check your search API key in Settings.');
      if (response.status === 429 || response.status === 432 || response.status === 433) {
        throw new Error('Tavily search limit reached. Check your search quota or try again later.');
      }
      throw new Error('Tavily search failed (HTTP ' + response.status + '). Try again.');
    }
    data = await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error('Web search timed out. Try again.', { cause: error });
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error('Could not complete the Tavily search. Check your connection and try again.', { cause: error });
    }
    throw error;
  }

  if (!isRecord(data) || !Array.isArray(data.results)) throw new Error('Tavily returned an unreadable search response. Try again.');
  const results: SearchResult[] = [];
  for (const item of data.results) {
    if (!isRecord(item) || !isExternalUrl(item.url) || !/^https?:\/\//i.test(item.url) ||
        typeof item.content !== 'string' || !item.content.trim()) continue;
    const url = new URL(item.url).href;
    if (results.some(result => result.url === url)) continue;
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 200) : '';
    const date = typeof item.published_date === 'string' ? item.published_date.slice(0, 80) : '';
    const excerpt = item.content.trim().slice(0, 1200);
    results.push({ url, title: title || new URL(url).hostname, excerpt: date ? date + ' · ' + excerpt : excerpt });
    if (results.length === maxResults) break;
  }
  if (!results.length) throw new Error('No usable web results found. Try a more specific question.');
  return results;
}
