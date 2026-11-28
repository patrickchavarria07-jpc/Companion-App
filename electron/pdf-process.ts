import { utilityProcess } from 'electron';
import { join } from 'node:path';
import type { PdfWorkerResponse } from './pdf-worker';

export const defaultPdfTimeoutMs = 60_000;

function abortError(signal: AbortSignal): Error {
  const { reason } = signal;
  return reason instanceof Error ? reason : new DOMException('PDF extraction aborted.', 'AbortError');
}

/** Extracts PDF text in a short-lived, isolated utility process that is killed on completion, abort, or timeout. */
export function readPdfInUtilityProcess(
  bytes: Uint8Array,
  signal?: AbortSignal,
  timeoutMs = defaultPdfTimeoutMs,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'pdf-worker.js'), [], {
      serviceName: 'Research Buddy PDF reader',
      stdio: 'ignore',
    });
    let settled = false;
    const onAbort = () => finish(abortError(signal!));
    const finish = (error: Error | undefined, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      if (error) reject(error);
      else resolve(text);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error('Reading this PDF took too long. Try a smaller file.')), timeoutMs);
    child.once('spawn', () => child.postMessage({ bytes }));
    child.once('message', (response: PdfWorkerResponse) => {
      if (response.ok) finish(undefined, response.text);
      else finish(new Error(response.message));
    });
    child.once('exit', () => finish(new Error('Could not read this PDF. Check that it opens and is free of password protection.')));
  });
}
