import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../electron/attachments';
import {
  excerptDocument, isExternalUrl, isRequestId, validateAttachmentPath, validateMessages, withAttachments,
} from '../electron/validation';
import { fitConversation } from '../shared/protocol';

describe('validateMessages', () => {
  it('returns a clean copy of valid messages', () => {
    const input = [{ role: 'user', content: 'Hi', extra: true }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Q' }];
    expect(validateMessages(input)).toEqual([
      { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Q' },
    ]);
  });

  it.each([
    ['not an array', 'hello'],
    ['empty', []],
    ['null entry', [null]],
    ['bad role', [{ role: 'system', content: 'x' }]],
    ['non-string content', [{ role: 'user', content: 5 }]],
    ['blank latest message', [{ role: 'user', content: '   ' }]],
    ['last message from assistant', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]],
  ])('rejects malformed input: %s', (_label, input) => {
    expect(() => validateMessages(input)).toThrow('Invalid chat request');
  });

  it('rejects conversations over the message or character limits', () => {
    const many = Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' }));
    expect(() => validateMessages(many)).toThrow('too long');
    expect(() => validateMessages([{ role: 'user', content: 'x'.repeat(100_001) }])).toThrow('too long');
  });
});

describe('fitConversation', () => {
  it('keeps recent turns starting on a user message when limits are exceeded', () => {
    const turns = Array.from({ length: 104 }, (_, idx) => ({
      role: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg-${idx}`,
    }));
    // Append a final user turn (total 105 messages).
    turns.push({ role: 'user', content: 'latest' });
    const fitted = fitConversation(turns);
    expect(fitted.messages.length).toBeLessThanOrEqual(100);
    expect(fitted.messages[0].role).toBe('user');
    expect(fitted.messages.at(-1)?.content).toBe('latest');
    expect(fitted.trimmed).toBeGreaterThan(0);
  });

  it('rejects a single message exceeding 100,000 characters', () => {
    expect(() => fitConversation([{ role: 'user', content: 'x'.repeat(100_001) }]))
      .toThrow('under 100,000 characters');
  });
});

describe('request helpers', () => {
  it('validates request ids', () => {
    expect(isRequestId('abc')).toBe(true);
    expect(isRequestId('')).toBe(false);
    expect(isRequestId(42)).toBe(false);
    expect(isRequestId('x'.repeat(101))).toBe(false);
  });

  it('accepts absolute PDF and supported plain-text research paths', () => {
    for (const name of ['paper.pdf', 'notes.txt', 'study.md', 'results.csv', 'refs.bib', 'draft.tex', 'data.json']) {
      const path = resolve(name);
      expect(validateAttachmentPath(path)).toBe(path);
    }
    expect(() => validateAttachmentPath('paper.pdf')).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(42)).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(resolve('a\0.txt'))).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(resolve('notes.docx'))).toThrow('Drop a PDF or supported text file');
  });

  it('allows only web and mail links to open externally', () => {
    expect(isExternalUrl('https://example.com/paper?id=1')).toBe(true);
    expect(isExternalUrl('http://example.com')).toBe(true);
    expect(isExternalUrl('mailto:someone@example.com')).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:', 'https://user:pw@example.com', 'not a url', 42, 'https://' + 'a'.repeat(2050)]) {
      expect(isExternalUrl(url)).toBe(false);
    }
  });

  it('places <=60k attachments on the first user message so multi-turn prefixes stay cacheable', () => {
    const turn1 = [{ role: 'user' as const, content: 'First' }];
    const turn2 = [...turn1, { role: 'assistant' as const, content: 'Ok' }, { role: 'user' as const, content: 'Summarize' }];
    const docs = [{ name: 'a.txt', text: 'Body' }];

    expect(withAttachments(turn2, [])).toBe(turn2);
    const req1 = withAttachments(turn1, docs);
    const req2 = withAttachments(turn2, docs);
    expect(req1[0].content).toBe('Attached source material (JSON):\n[{"name":"a.txt","text":"Body"}]\n\nUser request:\nFirst');
    expect(req2[0]).toEqual(req1[0]);
    expect(req2.slice(1)).toEqual(turn2.slice(1));
  });

  it('selects query-relevant excerpts in document order when attachments exceed the prompt budget', () => {
    const pages = Array.from({ length: 10 }, (_, idx) =>
      `Page ${idx + 1}\n` + (idx === 7 ? 'mitochondrial biogenesis findings '.repeat(30) : 'background filler text '.repeat(40)),
    ).join('\n\n');
    const excerpt = excerptDocument(pages, 'What are the mitochondrial biogenesis findings?', 3_000);
    expect(excerpt.length).toBeLessThanOrEqual(3_000);
    expect(excerpt).toContain('Page 1\n');
    expect(excerpt).toContain('Page 8\n');
    expect(excerpt.indexOf('Page 1\n')).toBeLessThan(excerpt.indexOf('Page 8\n'));

    const messages = [{ role: 'user' as const, content: 'mitochondrial biogenesis' }];
    const withExcerpts = withAttachments(messages, [{ name: 'big.pdf', text: pages }], 3_000);
    expect(withExcerpts[0].content).toContain('"excerpted":true');
    expect(withExcerpts[0].content).toContain('Page 8');
  });
});

describe('AttachmentStore', () => {
  it('enforces count and character limits and flags >60k documents as excerpted', () => {
    const store = new AttachmentStore();
    expect(store.add('a.txt', 'x'.repeat(50_000), '/docs/a.txt')).toEqual({ name: 'a.txt', characters: 50_000 });
    expect(store.add('large.pdf', 'y'.repeat(80_000), '/docs/large.pdf'))
      .toEqual({ name: 'large.pdf', characters: 80_000, excerpted: true });
    expect(() => store.add('too-big.pdf', 'z'.repeat(300_001), '/docs/too-big.pdf')).toThrow('limit reached');
    store.clear();
    for (let index = 0; index < 10; index++) store.add(index + '.txt', 'z', '/docs/' + index + '.txt');
    expect(() => store.add('extra.txt', 'z', '/docs/extra.txt')).toThrow('limit reached');
    expect(store.size).toBe(10);
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('rejects the same file twice but numbers different files that share a name', () => {
    const store = new AttachmentStore();
    store.add('notes.txt', 'one', '/a/notes.txt');
    expect(() => store.add('notes.txt', 'again', '/a/notes.txt')).toThrow('already attached');
    expect(store.add('notes.txt', 'two', '/b/notes.txt').name).toBe('notes (2).txt');
    expect(store.add('notes.txt', 'three', '/c/notes.txt').name).toBe('notes (3).txt');
    store.remove('notes (2).txt');
    expect(store.add('notes.txt', 'four', '/d/notes.txt').name).toBe('notes (2).txt');
    expect(store.add('README', 'x', '/a/README').name).toBe('README');
    expect(store.add('README', 'y', '/b/README').name).toBe('README (2)');
    expect(store.list().map(item => item.name)).toEqual(['notes.txt', 'notes (3).txt', 'notes (2).txt', 'README', 'README (2)']);
  });
});
