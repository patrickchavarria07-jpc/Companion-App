import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinTextItems, pdfText } from '../electron/pdf';
import { makePdf } from './helpers/pdf';

const assetsDir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

describe('joinTextItems', () => {
  it('joins mid-word kerned spans without inserting spaces and preserves word gaps', () => {
    expect(joinTextItems([
      { str: 'ef', width: 10, transform: [12, 0, 0, 12, 72, 720] },
      { str: 'fi', width: 6, transform: [12, 0, 0, 12, 82.2, 720] },
      { str: 'cient', width: 24, transform: [12, 0, 0, 12, 88.3, 720] },
      { str: '', hasEOL: false },
      { str: 'methods', width: 40, transform: [12, 0, 0, 12, 117, 720] },
      { str: 'Next line', width: 45, transform: [12, 0, 0, 12, 72, 704] },
    ])).toBe('efficient methods\nNext line');
  });
});

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
