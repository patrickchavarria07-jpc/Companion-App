import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../electron/attachments';
import { isRequestId, validateAttachmentPath, validateMessages, withAttachments } from '../electron/validation';

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

describe('request helpers', () => {
  it('validates request ids', () => {
    expect(isRequestId('abc')).toBe(true);
    expect(isRequestId('')).toBe(false);
    expect(isRequestId(42)).toBe(false);
    expect(isRequestId('x'.repeat(101))).toBe(false);
  });

  it('accepts only absolute PDF or TXT paths', () => {
    const path = resolve('paper.pdf');
    expect(validateAttachmentPath(path)).toBe(path);
    expect(() => validateAttachmentPath('paper.pdf')).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(42)).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(resolve('a\0.txt'))).toThrow('saved on this computer');
    expect(() => validateAttachmentPath(resolve('notes.docx'))).toThrow('PDF or TXT');
  });

  it('adds attachments to the last user message only', () => {
    const messages = [{ role: 'user' as const, content: 'First' }, { role: 'assistant' as const, content: 'Ok' }, { role: 'user' as const, content: 'Summarize' }];
    expect(withAttachments(messages, [])).toBe(messages);
    const result = withAttachments(messages, [{ name: 'a.txt', text: 'Body' }]);
    expect(result.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(result[2].content).toBe('Attached source material (JSON):\n[{"name":"a.txt","text":"Body"}]\n\nUser request:\nSummarize');
    expect(messages[2].content).toBe('Summarize');
  });
});

describe('AttachmentStore', () => {
  it('enforces unique names, count, and character limits', () => {
    const store = new AttachmentStore();
    expect(store.add('a.txt', 'x'.repeat(50_000))).toEqual({ name: 'a.txt', characters: 50_000 });
    expect(() => store.add('a.txt', 'y')).toThrow('already attached');
    expect(() => store.add('b.txt', 'y'.repeat(10_001))).toThrow('limit reached');
    store.remove('a.txt');
    for (let index = 0; index < 10; index++) store.add(index + '.txt', 'z');
    expect(() => store.add('extra.txt', 'z')).toThrow('limit reached');
    expect(store.size).toBe(10);
    store.clear();
    expect(store.list()).toEqual([]);
  });
});
