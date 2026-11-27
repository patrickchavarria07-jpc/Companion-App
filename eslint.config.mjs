import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'dist-electron/', 'release/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Keeps component modules compatible with Fast Refresh (components only, no stray exports).
  { files: ['src/**/*.tsx'], ...reactRefresh.configs.vite() },
  {
    files: ['electron/**/*.ts', 'shared/**/*.ts', 'tests/**/*.{ts,tsx}', '*.config.{ts,mjs}', 'vite.csp.ts'],
    languageOptions: { globals: globals.node },
  },
);
