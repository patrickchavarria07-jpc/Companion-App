import { describe, expect, it, vi } from 'vitest';
import { prepareChat, type SearchRunner } from '../electron/chat';

describe('prepareChat', () => {
  it('places attachments on the first user message and numbers web search results from 1', async () => {
    const runSearch = vi.fn<SearchRunner>(async () => [
      { title: 'Paper A', url: 'https://example.com/a', excerpt: 'Finding A' },
      { title: 'Paper B', url: 'https://example.com/b', excerpt: 'Finding B' },
    ]);

    const prepared = await prepareChat({
      input: [
        { role: 'user', content: 'CRISPR prime editing trial' },
        { role: 'assistant', content: 'Initial summary' },
        { role: 'user', content: 'Are there 2026 updates on that trial?' },
      ],
      attachments: [{ name: 'protocol.txt', text: 'Trial protocol body' }],
      systemPrompt: 'Base prompt.',
      search: true,
      signal: new AbortController().signal,
      runSearch,
    });

    expect(runSearch).toHaveBeenCalledOnce();
    expect(runSearch.mock.calls[0][0]).toContain('CRISPR prime editing trial');
    expect(prepared.request[0].content).toContain('Attached source material (JSON):');
    expect(prepared.request[2].content).toContain('"id":1,"title":"Paper A"');
    expect(prepared.request[2].content).toContain('"id":2,"title":"Paper B"');
    expect(prepared.sources).toEqual([
      { title: 'Paper A', url: 'https://example.com/a' },
      { title: 'Paper B', url: 'https://example.com/b' },
    ]);
    expect(prepared.systemPrompt).toContain('1-based id in brackets, such as [1]');
  });

  it('trims older messages automatically instead of failing when conversation exceeds 100 messages', async () => {
    const history = Array.from({ length: 102 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index}`,
    }));
    history.push({ role: 'user', content: 'Final question' });

    const prepared = await prepareChat({
      input: history,
      attachments: [],
      systemPrompt: 'Base',
      search: false,
      signal: new AbortController().signal,
    });

    expect(prepared.trimmed).toBeGreaterThan(0);
    expect(prepared.request.length).toBeLessThanOrEqual(100);
    expect(prepared.request[0].role).toBe('user');
    expect(prepared.request.at(-1)?.content).toBe('Final question');
  });
});
