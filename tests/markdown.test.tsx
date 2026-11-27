import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/Markdown';

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders common Markdown and GitHub tables', () => {
    const html = render('# Findings\n\n**Bold** and `code`\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1>Findings</h1>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<td>2</td>');
  });

  it('opens web links in a new window and neutralizes other links', () => {
    expect(render('[paper](https://example.com/p)')).toContain('<a href="https://example.com/p" target="_blank" rel="noreferrer noopener" title="https://example.com/p">paper</a>');
    expect(render('[local](notes.html)')).toBe('<div class="markdown"><p><span>local</span></p></div>');
    expect(render('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('shows raw HTML as text instead of rendering it', () => {
    const html = render('Hello <img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });

  it('turns images into links so remote content is never loaded', () => {
    const html = render('![chart](https://example.com/chart.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/chart.png" target="_blank" rel="noreferrer noopener" title="https://example.com/chart.png">chart</a>');
  });
});
