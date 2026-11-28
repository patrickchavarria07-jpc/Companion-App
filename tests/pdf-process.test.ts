import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockUtilityProcess extends EventEmitter {
  killed = false;
  posted: unknown[] = [];
  postMessage(message: unknown) { this.posted.push(message); }
  kill() {
    this.killed = true;
    return true;
  }
}

const state = vi.hoisted(() => ({ current: null as MockUtilityProcess | null }));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new MockUtilityProcess();
      state.current = child;
      return child;
    },
  },
}));

const { readPdfInUtilityProcess } = await import('../electron/pdf-process');

beforeEach(() => { state.current = null; });

describe('readPdfInUtilityProcess', () => {
  it('posts bytes on spawn, resolves worker text, and kills the child process', async () => {
    const promise = readPdfInUtilityProcess(new Uint8Array([1, 2, 3]));
    const child = state.current!;
    child.emit('spawn');
    expect(child.posted).toHaveLength(1);
    child.emit('message', { ok: true, text: 'Page 1\nExtracted' });
    await expect(promise).resolves.toBe('Page 1\nExtracted');
    expect(child.killed).toBe(true);
  });

  it('kills the worker immediately when aborted via AbortSignal', async () => {
    const controller = new AbortController();
    const promise = readPdfInUtilityProcess(new Uint8Array([1]), controller.signal);
    const child = state.current!;
    child.emit('spawn');
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.killed).toBe(true);
  });

  it('kills the worker and rejects when extraction times out', async () => {
    const promise = readPdfInUtilityProcess(new Uint8Array([1]), undefined, 25);
    const child = state.current!;
    child.emit('spawn');
    await expect(promise).rejects.toThrow('took too long');
    expect(child.killed).toBe(true);
  });
});
