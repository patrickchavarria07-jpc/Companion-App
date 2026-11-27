import type { WebSource } from '../shared/protocol';
import { isExternalUrl, isRecord } from './validation';

type SearchResult = WebSource & { excerpt: string };
const maxResults = 5;
const maxQueryLength = 400;

export async function searchWeb(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) throw new Error('Set TAVILY_API_KEY and restart Research Buddy to use web search. See the README for setup.');
  if (!/^[!-~]+$/.test(key)) throw new Error('TAVILY_API_KEY contains invalid characters.');
  if (query.length > maxQueryLength) throw new Error('Keep your web search question to 400 characters or fewer.');

  const timeout = AbortSignal.timeout(12_000);
  let data: unknown;
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: maxResults, auto_parameters: false, include_published_date: true }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new Error('Tavily rejected access. Check your search API key.');
      if (response.status === 429 || response.status === 432) throw new Error('Tavily search limit reached. Check your search quota or try again later.');
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
