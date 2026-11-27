import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extract } from '../electron/documents';

let dir: string;
const neverPdf = () => Promise.reject(new Error('PDF reader should not be called'));

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'buddy-docs-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function file(name: string, data: string | Uint8Array) {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe('extract', () => {
  it('reads UTF-8 text files and trims whitespace', async () => {
    const result = await extract(await file('notes.txt', '\uFEFF  Hello, wörld  \n'), neverPdf);
    expect(result).toEqual({ name: 'notes.txt', text: 'Hello, wörld' });
  });

  it('detects UTF-16 byte-order marks', async () => {
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from('Hi there', 'utf16le')]);
    expect((await extract(await file('le.txt', le), neverPdf)).text).toBe('Hi there');
    const be = Buffer.from('Hi', 'utf16le').swap16();
    expect((await extract(await file('be.txt', new Uint8Array([0xfe, 0xff, ...be])), neverPdf)).text).toBe('Hi');
  });

  it('rejects text that is not valid UTF-8', async () => {
    await expect(extract(await file('latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9])), neverPdf))
      .rejects.toThrow('Save the text file as UTF-8');
  });

  it('rejects unsupported extensions, missing files, and oversized files', async () => {
    await expect(extract(await file('data.csv', 'a,b'), neverPdf)).rejects.toThrow('Drop a PDF or TXT file.');
    await expect(extract(join(dir, 'missing.txt'), neverPdf)).rejects.toThrow('Could not open that file.');
    const big = await file('big.txt', '');
    await truncate(big, 20 * 1024 * 1024 + 1);
    await expect(extract(big, neverPdf)).rejects.toThrow('under 20 MB');
  });

  it('rejects empty documents and documents over the character limit', async () => {
    await expect(extract(await file('blank.txt', '   \n'), neverPdf)).rejects.toThrow('No readable text');
    await expect(extract(await file('long.txt', 'a'.repeat(60_001)), neverPdf)).rejects.toThrow('exceeds 60,000 characters');
  });

  it('passes PDF bytes to the injected reader', async () => {
    const readPdf = vi.fn(async (bytes: Uint8Array) => 'Page 1\n' + new TextDecoder().decode(bytes));
    const result = await extract(await file('Paper.PDF', 'pdf-bytes'), readPdf);
    expect(readPdf).toHaveBeenCalledOnce();
    expect(result).toEqual({ name: 'Paper.PDF', text: 'Page 1\npdf-bytes' });
  });
});
