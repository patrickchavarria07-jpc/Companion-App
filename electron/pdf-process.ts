import { utilityProcess } from 'electron';
import { join } from 'node:path';
import type { PdfWorkerResponse } from './pdf-worker';

const timeoutMs = 60_000;

/** Extracts PDF text in a short-lived, isolated utility process that is killed on completion or timeout. */
export function readPdfInUtilityProcess(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'pdf-worker.js'), [], {
      serviceName: 'Research Buddy PDF reader',
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (error: Error | undefined, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(text);
    };
    const timer = setTimeout(() => finish(new Error('Reading this PDF took too long. Try a smaller file.')), timeoutMs);
    child.once('spawn', () => child.postMessage({ bytes }));
    child.once('message', (response: PdfWorkerResponse) => {
      if (response.ok) finish(undefined, response.text);
      else finish(new Error(response.message));
    });
    child.once('exit', () => finish(new Error('Could not read this PDF. Check that it opens and is free of password protection.')));
  });
}
