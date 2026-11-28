import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { isSupportedExtension, isTextExtension, limits } from './validation';

/** Extracts text from PDF bytes. In the app this runs in an isolated utility process. */
export type PdfReader = (bytes: Uint8Array) => Promise<string>;

export async function extract(
  filePath: string,
  readPdf: PdfReader,
  signal?: AbortSignal,
): Promise<{ name: string; text: string }> {
  signal?.throwIfAborted();
  const name = basename(filePath);
  if (!isSupportedExtension(name)) {
    throw new Error('Drop a PDF or supported text file (.txt, .md, .csv, .json, .bib, .tex).');
  }
  const file = await open(filePath, 'r').catch(() => { throw new Error('Could not open that file.'); });
  let bytes: Uint8Array;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limits.fileBytes) throw new Error('Choose a file under 20 MB.');
    const data = new Uint8Array(info.size);
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    bytes = data.subarray(0, offset);
  } finally {
    await file.close();
  }
  signal?.throwIfAborted();
  const text = (isTextExtension(name) ? decode(bytes) : await readPdf(bytes)).trim();
  signal?.throwIfAborted();
  if (!text) throw new Error('No readable text found. Scanned PDFs need OCR before upload.');
  if (text.length > limits.documentCharacters) {
    throw new Error('This document exceeds 300,000 characters. Try a shorter excerpt.');
  }
  return { name, text };
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
