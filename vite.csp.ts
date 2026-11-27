import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

export const devServerSocket = 'ws://127.0.0.1:5173';

/**
 * Relaxes the production CSP from index.html just enough for `vite` dev: allows the HMR websocket and,
 * instead of 'unsafe-inline', the exact SHA-256 hashes of inline scripts that dev plugins inject
 * (such as the React Fast Refresh preamble).
 */
export function withDevCsp(html: string): string {
  const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  return html.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/, (_match, start: string, policy: string, end: string) => {
    let relaxed = policy.replace("connect-src 'self'", `connect-src 'self' ${devServerSocket}`);
    if (hashes.length) relaxed = relaxed.replace("script-src 'self'", `script-src 'self' ${[...new Set(hashes)].join(' ')}`);
    return start + relaxed + end;
  });
}

export const devCsp = (): Plugin => ({
  name: 'research-buddy-dev-csp',
  apply: 'serve',
  // Run last so inline scripts injected by other plugins are already in the HTML.
  transformIndexHtml: { order: 'post', handler: withDevCsp },
});
