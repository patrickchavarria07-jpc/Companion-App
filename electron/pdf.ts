import { join, sep } from 'node:path';
import { limits } from './validation';

const pageLimitMessage = 'This PDF exceeds 300 pages. Try a shorter excerpt.';

export type PdfTextSpan = {
  str: string;
  hasEOL?: boolean;
  width?: number;
  height?: number;
  transform?: unknown[];
};

function coords(item: PdfTextSpan): { x: number; y: number; fontSize: number } | undefined {
  if (!Array.isArray(item.transform) || item.transform.length < 6) return undefined;
  const [a, b, , d, x, y] = item.transform;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const scale = typeof a === 'number' && typeof b === 'number' ? Math.hypot(a, b) : 0;
  const dy = typeof d === 'number' ? Math.abs(d) : 0;
  const fontSize = scale || dy || (typeof item.height === 'number' && item.height > 0 ? item.height : 12);
  return { x, y, fontSize };
}

/** Joins `pdf.js` text items without splitting mid-word ligatures/kerning or injecting spaces on empty spans. */
export function joinTextItems(items: readonly (PdfTextSpan | Record<string, unknown>)[]): string {
  let out = '';
  let prev: PdfTextSpan | undefined;
  let forceBreak = false;

  for (const raw of items) {
    if (!('str' in raw) || typeof raw.str !== 'string') continue;
    const item = raw as PdfTextSpan;
    if (!item.str) {
      if (item.hasEOL) forceBreak = true;
      continue;
    }

    if (prev) {
      if (forceBreak || prev.hasEOL) {
        if (!out.endsWith('\n')) out += '\n';
      } else {
        const prevPos = coords(prev);
        const nextPos = coords(item);
        const fontSize = nextPos?.fontSize ?? prevPos?.fontSize ?? 12;
        if (prevPos && nextPos && Math.abs(nextPos.y - prevPos.y) > fontSize * 0.5) {
          if (!out.endsWith('\n')) out += '\n';
        } else if (!/\s$/.test(prev.str) && !/^\s/.test(item.str)) {
          if (prevPos && nextPos && typeof prev.width === 'number' && prev.width > 0) {
            const gap = nextPos.x - (prevPos.x + prev.width);
            if (gap >= fontSize * 0.14) out += ' ';
          } else if (!/[([{—–-]$/.test(prev.str) && !/^[,.;:!?)\]}]/.test(item.str)) {
            out += ' ';
          }
        }
      }
    }

    out += item.str;
    prev = item;
    forceBreak = Boolean(item.hasEOL);
  }

  return out.trim();
}

/**
 * Extracts page-labelled text from PDF bytes with pdf.js.
 * `assetsDir` is the root of the installed `pdfjs-dist` package (fonts, cMaps, wasm).
 * Never call this in the Electron main process; see pdf-process.ts.
 */
export async function pdfText(data: Uint8Array, assetsDir: string): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assetUrl = (directory: string) => join(assetsDir, directory).split(sep).join('/') + '/';
  const task = getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    standardFontDataUrl: assetUrl('standard_fonts'),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    wasmUrl: assetUrl('wasm'),
    verbosity: 0,
  });
  const pages: string[] = [];
  let total = 0;
  try {
    const pdf = await task.promise;
    if (pdf.numPages > limits.pdfPages) throw new Error(pageLimitMessage);
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = joinTextItems(content.items as PdfTextSpan[]);
      page.cleanup();
      if (!text) continue;
      const labeled = 'Page ' + index + '\n' + text;
      pages.push(labeled);
      total += labeled.length + 2;
      // Stop early: the caller rejects documents over the limit anyway.
      if (total > limits.documentCharacters + 2) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === pageLimitMessage) throw error;
    throw new Error('Could not read this PDF. Check that it opens and is free of password protection.', { cause: error });
  } finally {
    await task.destroy();
  }
  return pages.join('\n\n');
}
