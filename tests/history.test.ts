import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));

const { loadHistory, saveHistory, clearHistory, parseHistory } = await import('../electron/history');
const file = () => join(state.dir, 'history.json');

beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), 'buddy-history-')); });
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }); });

describe('history', () => {
  it('returns null when no history file exists', async () => {
    expect(await loadHistory()).toBeNull();
  });

  it('saves and reloads a conversation', async () => {
    await saveHistory({
      version: 1,
      savedAt: 1000,
      messages: [
        { id: 'u1', role: 'user', content: 'Question?' },
        { id: 'a1', role: 'assistant', content: 'Answer.', sources: [{ title: 'Src', url: 'https://example.com' }] },
      ],
      attachments: [{ name: 'paper.pdf', characters: 1200 }],
    });
    const loaded = await loadHistory();
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.attachments).toEqual([{ name: 'paper.pdf', characters: 1200 }]);
    const stored = JSON.parse(await readFile(file(), 'utf8'));
    expect(stored.version).toBe(1);
    expect(stored.savedAt).toBe(1000);
  });

  it('deletes the file when saving an empty history', async () => {
    await saveHistory({ version: 1, savedAt: Date.now(), messages: [{ id: 'u', role: 'user', content: 'hi' }], attachments: [] });
    expect(await loadHistory()).not.toBeNull();
    await saveHistory({ version: 1, savedAt: Date.now(), messages: [], attachments: [] });
    expect(await loadHistory()).toBeNull();
    const files = await readdir(state.dir);
    expect(files.some(name => name.startsWith('history.json'))).toBe(false);
  });

  it('normalizes untrusted history and drops malformed fields', () => {
    expect(parseHistory(null)).toBeUndefined();
    expect(parseHistory({ version: 2, messages: [] })).toBeUndefined();
    expect(parseHistory({ version: 1, messages: 'nope' })).toBeUndefined();
    expect(parseHistory({ version: 1, messages: [], attachments: [] })).toBeUndefined();

    const parsed = parseHistory({
      version: 1,
      messages: [
        { id: 5, role: 'user', content: 'ok' },
        { role: 'wizard', content: 'bad role' },
        { role: 'assistant', content: 'a'.repeat(200_000) },
        { id: 'a', role: 'assistant', content: 'good', sources: [{ title: 'T', url: 'https://e.com' }, { title: 'bad' }] },
      ],
      attachments: [{ name: 'x.pdf' }, { name: 'y'.repeat(999), characters: 10 }, 'junk', { name: 'z.pdf', characters: 5 }],
    });
    expect(parsed).toBeDefined();
    // Only the valid user and assistant messages remain; oversized content is dropped.
    expect(parsed!.messages).toEqual([
      { id: expect.any(String), role: 'user', content: 'ok' },
      { id: 'a', role: 'assistant', content: 'good', sources: [{ title: 'T', url: 'https://e.com' }] },
    ]);
    // Invalid attachment names and non-object entries are dropped.
    expect(parsed!.attachments).toEqual([{ name: 'x.pdf', characters: 0 }, { name: 'z.pdf', characters: 5 }]);
  });

  it('keeps at most the last 100 messages', () => {
    const messages = Array.from({ length: 120 }, (_, i) => ({ id: 'm' + i, role: i % 2 === 0 ? 'user' : 'assistant', content: 'm' + i }));
    const parsed = parseHistory({ version: 1, messages, attachments: [] });
    expect(parsed!.messages).toHaveLength(100);
    expect(parsed!.messages[0].content).toBe('m20');
  });

  it('clearHistory removes the file', async () => {
    await saveHistory({ version: 1, savedAt: Date.now(), messages: [{ id: 'u', role: 'user', content: 'hi' }], attachments: [] });
    await clearHistory();
    expect(await loadHistory()).toBeNull();
  });
});
