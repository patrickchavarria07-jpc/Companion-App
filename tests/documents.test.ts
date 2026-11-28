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
  it('reads UTF-8 text and common research file extensions', async () => {
    expect(await extract(await file('notes.txt', '\uFEFF  Hello, wörld  \n'), neverPdf))
      .toEqual({ name: 'notes.txt', text: 'Hello, wörld' });
    expect((await extract(await file('paper.md', '# Abstract\n\nBody'), neverPdf)).text).toBe('# Abstract\n\nBody');
    expect((await extract(await file('data.csv', 'col1,col2\n1,2\n'), neverPdf)).text).toBe('col1,col2\n1,2');
    expect((await extract(await file('refs.bib', '@article{k, title={T}}'), neverPdf)).text).toBe('@article{k, title={T}}');
    expect((await extract(await file('draft.tex', '\\section{Intro}'), neverPdf)).text).toBe('\\section{Intro}');
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
    await expect(extract(await file('archive.docx', 'PK..'), neverPdf)).rejects.toThrow('Drop a PDF or supported text file');
    await expect(extract(join(dir, 'missing.txt'), neverPdf)).rejects.toThrow('Could not open that file.');
    const big = await file('big.txt', '');
    await truncate(big, 20 * 1024 * 1024 + 1);
    await expect(extract(big, neverPdf)).rejects.toThrow('under 20 MB');
  });

  it('accepts documents over 60k up to 300k characters and rejects empty or >300k documents', async () => {
    await expect(extract(await file('blank.txt', '   \n'), neverPdf)).rejects.toThrow('No readable text');
    const medium = await extract(await file('paper-80k.txt', 'a'.repeat(80_000)), neverPdf);
    expect(medium.text.length).toBe(80_000);
    await expect(extract(await file('huge.txt', 'a'.repeat(300_001)), neverPdf)).rejects.toThrow('exceeds 300,000 characters');
  });

  it('passes PDF bytes to the injected reader and respects AbortSignal', async () => {
    const readPdf = vi.fn(async (bytes: Uint8Array) => 'Page 1\n' + new TextDecoder().decode(bytes));
    const result = await extract(await file('Paper.PDF', 'pdf-bytes'), readPdf);
    expect(readPdf).toHaveBeenCalledOnce();
    expect(result).toEqual({ name: 'Paper.PDF', text: 'Page 1\npdf-bytes' });

    const aborted = new AbortController();
    aborted.abort();
    await expect(extract(await file('aborted.txt', 'text'), neverPdf, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
