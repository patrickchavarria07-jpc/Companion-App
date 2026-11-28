import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, searchWeb } from '../electron/web-search';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('buildSearchQuery', () => {
  it('keeps standalone queries unchanged and enriches short follow-ups with prior topic', () => {
    expect(buildSearchQuery([{ role: 'user', content: 'Latest IPCC sea level report' }]))
      .toBe('Latest IPCC sea level report');

    const contextual = buildSearchQuery([
      { role: 'user', content: 'CRISPR prime editing clinical trial results' },
      { role: 'assistant', content: 'Phase 1 showed promising safety.' },
      { role: 'user', content: 'Are there 2026 follow-up outcomes for that trial?' },
    ]);
    expect(contextual).toContain('CRISPR prime editing');
    expect(contextual).toContain('Are there 2026 follow-up outcomes');
    expect(contextual.length).toBeLessThanOrEqual(400);
  });

  it('condenses >400-character passages while keeping the trailing question within 400 characters', () => {
    const longClaim = 'Recent preprint claims room-temperature superconductivity in copper-substituted apatite samples '.repeat(6);
    const query = buildSearchQuery([{ role: 'user', content: `${longClaim} Has this claim been replicated independently?` }]);
    expect(query.length).toBeLessThanOrEqual(400);
    expect(query).toContain('Has this claim been replicated independently?');
  });
});

describe('searchWeb', () => {
  it('uses basic search and keeps only distinct web links with excerpts', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    const source = { title: 'Example', url: 'https://example.com/story', content: 'Current news' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      results: [source, source, { ...source, url: 'mailto:test@example.com' }, { ...source, url: 'https://example.org', content: '' }],
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(searchWeb('Latest news', new AbortController().signal)).resolves.toEqual([
      { title: source.title, url: source.url, excerpt: source.content },
    ]);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(request?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(request?.body))).toMatchObject({ query: 'Latest news', search_depth: 'basic', auto_parameters: false });
  });

  it('prefers an explicit saved API key and rejects blank or missing keys', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      results: [{ title: 'Result', url: 'https://example.com', content: 'Snippet' }],
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(searchWeb('Latest news', new AbortController().signal)).rejects.toThrow('TAVILY_API_KEY');
    expect(fetch).not.toHaveBeenCalled();

    await expect(searchWeb('   ', new AbortController().signal, 'saved-key')).rejects.toThrow('Enter a question');
    await expect(searchWeb('Latest news', new AbortController().signal, 'saved-key')).resolves.toHaveLength(1);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer saved-key' });
  });

  it('passes cancellation to the search request', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation((_url, request) =>
      new Promise((_resolve, reject) => {
        request?.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      })));
    const controller = new AbortController();
    const pending = searchWeb('Latest news', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
