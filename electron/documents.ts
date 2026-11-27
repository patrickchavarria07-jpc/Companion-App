import { open } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';

export const maxContext = 60_000;
const maxBytes = 20 * 1024 * 1024;

export async function extract(filePath: string): Promise<{ name: string; text: string }> {
  const name = basename(filePath);
  const extension = extname(name).toLowerCase();
  if (extension !== '.pdf' && extension !== '.txt') throw new Error('Drop a PDF or TXT file.');
  const file = await open(filePath, 'r').catch(() => { throw new Error('Could not open that file.'); });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Choose a file under 20 MB.');
    const data = new Uint8Array(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bytes = data.subarray(0, offset);
    const text = (extension === '.txt' ? decode(bytes) : await pdfText(bytes)).trim();
    if (!text) throw new Error('No readable text found. Scanned PDFs need OCR before upload.');
    if (text.length > maxContext) throw new Error('This document exceeds 60,000 characters. Try a shorter excerpt.');
    return { name, text };
  } finally {
    await file.close();
  }
}

function decode(bytes: Uint8Array): string {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Save the text file as UTF-8 and try again.');
  }
}

async function pdfText(data: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = dirname(require.resolve('pdfjs-dist/package.json'));
  const assetUrl = (directory: string) => join(assets, directory).split(sep).join('/') + '/';
  const task = getDocument({
    data,
    useSystemFonts: false,
    standardFontDataUrl: assetUrl('standard_fonts'),
    cMapUrl: assetUrl('cmaps'),
    wasmUrl: assetUrl('wasm'),
  });
  const pages: string[] = [];
  let total = 0;
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 300) throw new Error('This PDF exceeds 300 pages. Try a shorter excerpt.');
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      page.cleanup();
      if (!text) continue;
      const labeled = 'Page ' + index + '\n' + text;
      pages.push(labeled);
      total += labeled.length + 2;
      if (total > maxContext + 2) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('This PDF exceeds')) throw error;
    throw new Error('Could not read this PDF. Check that it opens and is free of password protection.');
  } finally {
    await task.destroy();
  }
  return pages.join('\n\n');
}
