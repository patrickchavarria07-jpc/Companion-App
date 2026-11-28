// Entry point for the isolated PDF utility process (see pdf-process.ts).
// Parsing untrusted PDFs here keeps pdf.js out of the privileged main process
// and keeps the main process responsive while large files are read.
import { dirname } from 'node:path';
import { pdfText } from './pdf';

export type PdfWorkerRequest = { bytes: Uint8Array };
export type PdfWorkerResponse = { ok: true; text: string } | { ok: false; message: string };

const assetsDir = dirname(require.resolve('pdfjs-dist/package.json'));

process.parentPort.once('message', async ({ data }: { data: PdfWorkerRequest }) => {
  let response: PdfWorkerResponse;
  const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  try {
    // PDF.js treats non-browser Electron processes as web environments.
    // This utility process has Node APIs and no DOM. Keep the Node detection
    // active through extraction, since PDF.js also loads its worker lazily.
    if (electronVersion) Object.defineProperty(process.versions, 'electron', { value: undefined });
    response = { ok: true, text: await pdfText(new Uint8Array(data.bytes), assetsDir) };
  } catch (error) {
    response = { ok: false, message: error instanceof Error ? error.message : 'Could not read this PDF.' };
  } finally {
    if (electronVersion) Object.defineProperty(process.versions, 'electron', electronVersion);
  }
  process.parentPort.postMessage(response);
});
