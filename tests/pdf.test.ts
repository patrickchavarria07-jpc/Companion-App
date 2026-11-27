import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfText } from '../electron/pdf';
import { makePdf } from './helpers/pdf';

const assetsDir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

describe('pdfText', () => {
  it('extracts page-labelled text and skips blank pages', async () => {
    const text = await pdfText(makePdf(['Hello research', '', 'Third page (notes)']), assetsDir);
    expect(text).toBe('Page 1\nHello research\n\nPage 3\nThird page (notes)');
  });

  it('returns an empty string for a PDF with no text layer', async () => {
    expect(await pdfText(makePdf(['', '']), assetsDir)).toBe('');
  });

  it('rejects PDFs over the page limit', async () => {
    const pages = Array.from({ length: 301 }, () => '');
    await expect(pdfText(makePdf(pages), assetsDir)).rejects.toThrow('exceeds 300 pages');
  });

  it('turns parser failures into a readable message', async () => {
    await expect(pdfText(new TextEncoder().encode('not a pdf'), assetsDir)).rejects.toThrow('Could not read this PDF');
  });
});
