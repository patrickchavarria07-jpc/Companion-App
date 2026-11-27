import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devCsp } from './vite.csp';

export default defineConfig({
  base: './',
  // plugin-react enables Fast Refresh: component edits update in place without losing chat state.
  plugins: [react(), devCsp()],
  server: { watch: { ignored: ['**/release/**', '**/dist-electron/**'] } },
});
