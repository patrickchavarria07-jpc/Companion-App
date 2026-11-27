import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { limits } from './validation';

/** Extracts text from PDF bytes. In the app this runs in an isolated utility process. */
export type PdfReader = (bytes: Uint8Array) => Promise<string>;

export async function extract(filePath: string, readPdf: PdfReader): Promise<{ name: string; text: string }> {
  const name = basename(filePath);
  const extension = extname(name).toLowerCase();
  if (extension !== '.pdf' && extension !== '.txt') throw new Error('Drop a PDF or TXT file.');
  const file = await open(filePath, 'r').catch(() => { throw new Error('Could not open that file.'); });
  let bytes: Uint8Array;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limits.fileBytes) throw new Error('Choose a file under 20 MB.');
    const data = new Uint8Array(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    bytes = data.subarray(0, offset);
  } finally {
    await file.close();
  }
  const text = (extension === '.txt' ? decode(bytes) : await readPdf(bytes)).trim();
  if (!text) throw new Error('No readable text found. Scanned PDFs need OCR before upload.');
  if (text.length > limits.attachmentCharacters) {
    throw new Error('This document exceeds 60,000 characters. Try a shorter excerpt.');
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
