import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withDevCsp } from '../vite.csp';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const policy = (html: string) => html.match(/Content-Security-Policy" content="([^"]*)"/)![1];

describe('content security policy', () => {
  it('ships a production policy without the dev server or inline scripts', () => {
    expect(policy(indexHtml)).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'");
  });

  it('allows the HMR socket and only the exact inline scripts injected in dev', () => {
    const preamble = 'import { injectIntoGlobalHook } from "/@react-refresh";\ninjectIntoGlobalHook(window);';
    const html = withDevCsp(`<script type="module">${preamble}</script><script type="module" src="/@vite/client"></script>` + indexHtml);
    const hash = createHash('sha256').update(preamble).digest('base64');
    expect(policy(html)).toContain(`script-src 'self' 'sha256-${hash}';`);
    expect(policy(html)).toContain("connect-src 'self' ws://127.0.0.1:5173;");
    expect(policy(html)).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('does not add hashes when there are no inline scripts', () => {
    expect(policy(withDevCsp(indexHtml))).toContain("script-src 'self';");
  });
});
