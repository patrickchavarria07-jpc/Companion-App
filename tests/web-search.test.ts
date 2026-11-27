import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWeb } from '../electron/web-search';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

  it('requires a key before contacting Tavily', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(searchWeb('Latest news', new AbortController().signal)).rejects.toThrow('TAVILY_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
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
