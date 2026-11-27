# Contributing

## Setup

Use Node.js 22.13 or later (`.nvmrc` pins the major version) and npm.

```sh
npm install
npm run dev
```

`npm run dev` starts Vite, recompiles `electron/` whenever it changes, and launches Electron with nodemon:

- Edits in `src/` hot-reload in place (React Fast Refresh) and keep the chat state.
- Edits in `electron/` or `shared/` restart the app automatically.
- Press `Ctrl+C` in the terminal to stop everything. Quitting the app from its × button leaves the dev tools running, waiting for the next change.

To load development API keys, copy `.env.example` to `.env`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Development app with hot reload |
| `npm test` / `npm run test:watch` | Vitest unit tests |
| `npm run lint` | ESLint (zero warnings allowed) |
| `npm run typecheck` | Type-check the renderer and Electron projects |
| `npm run build` | Clean, type-check, and compile into `dist/` and `dist-electron/` |
| `npm start` | Build, then run the production build |
| `npm run dist` | Build and package installers into `release/` |

## Before opening a pull request

1. Run `npm run lint`, `npm test`, and `npm run build`. CI runs the same steps and packages the app on Windows, macOS, and Linux.
2. Add or update tests in `tests/` for logic changes. Keep logic out of `electron/main.ts` and in modules that don't import Electron, so it stays testable.
3. Validate every new IPC argument in the main process, and add the channel to `docs/ARCHITECTURE.md`.
4. For changes to windowing, IPC, or PDF handling, also check by hand in `npm run dev`:
   - drag the widget and the panel header, then collapse, expand, and restart (the position should be remembered)
   - attach a PDF and a TXT file, ask a question, and stop a reply partway through
   - press `Ctrl+R` with an attachment; it should be gone afterwards

## Adding a provider

1. Add its default model to `models` in `shared/protocol.ts` and its display name to `providerNames` in `src/api.ts`.
2. Teach `buildRequest` in `electron/provider.ts` to build the request. If the reply format is new, handle it in `Reply.consume`.
3. Add request-building and streaming tests in `tests/provider.test.ts`.
4. Document the provider in the README.
