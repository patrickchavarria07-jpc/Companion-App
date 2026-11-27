import { join, sep } from 'node:path';
import { limits } from './validation';

const pageLimitMessage = 'This PDF exceeds 300 pages. Try a shorter excerpt.';

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
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      page.cleanup();
      if (!text) continue;
      const labeled = 'Page ' + index + '\n' + text;
      pages.push(labeled);
      total += labeled.length + 2;
      // Stop early: the caller rejects documents over the limit anyway.
      if (total > limits.attachmentCharacters + 2) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === pageLimitMessage) throw error;
    throw new Error('Could not read this PDF. Check that it opens and is free of password protection.', { cause: error });
  } finally {
    await task.destroy();
  }
  return pages.join('\n\n');
}
