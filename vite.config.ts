import { defineConfig, type Plugin } from 'vite';

// The production Content-Security-Policy in index.html only allows 'self'. During `vite` dev,
// allow the HMR websocket as well, so the dev server origin never ships in a build.
const devServerCsp = (): Plugin => ({
  name: 'research-buddy-dev-csp',
  apply: 'serve',
  transformIndexHtml: html => html.replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173"),
});

export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic' },
  plugins: [devServerCsp()],
  server: { watch: { ignored: ['**/release/**', '**/dist-electron/**'] } },
});
