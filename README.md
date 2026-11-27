# Research Buddy

Research Buddy is a floating Electron desktop companion for asking questions and analyzing PDF or TXT files.

## Run locally

Use Node.js 22.13 or later and npm. From the project folder, run:

```sh
npm install
npm run dev
```

On Windows PowerShell, use `npm.cmd` if script execution is disabled.

Drag the bot to move it. Click it to open chat. Drop a PDF or TXT onto the bot or panel, or use the attachment button. Once extraction finishes, ask a question or use **Summarize attachments**. The header lets you open Settings, collapse the panel, or quit.

## Connect a provider

Open **Settings**, select Gemini, Groq, OpenRouter, or Ollama, and enter the model ID. For a hosted provider, add your API key and save. Free model availability, quotas, and account requirements vary by provider. OpenRouter defaults to its free-model router. For Ollama, start the local server and pull the selected model, for example with `ollama pull llama3.2`. The app talks to `127.0.0.1:11434` by default; set `OLLAMA_HOST` (for example `OLLAMA_HOST=gpu-box:11434`) to use another address. When attachments make a request larger than Ollama's default context window, the app raises `num_ctx` for that request so documents are not silently truncated. Larger windows use more memory.

Leave the system prompt blank to use the built-in default.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Groq models](https://console.groq.com/docs/models) · [OpenRouter free router](https://openrouter.ai/openrouter/free) · [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)

The app stores keys encrypted with Electron safeStorage in `settings.json` in the OS userData directory (`%APPDATA%\Research Buddy` on Windows, `~/Library/Application Support/Research Buddy` on macOS, `~/.config/Research Buddy` on Linux). On Linux, persistent key storage requires an available system keyring. If the settings file becomes unreadable, the app moves it aside as `settings.json.corrupt-<timestamp>` and starts with defaults, so you need to re-enter your key.

The app also reads `GEMINI_API_KEY`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` from the environment, in both development and packaged builds. Settings shows when an environment key is in use. A key saved in Settings takes precedence. In development (`npm run dev`), the app also loads these from a `.env` file; copy `.env.example` to get started.

Chat and attachments live in memory until you quit or the window reloads. **New chat** clears the messages and keeps attached documents available. With hosted providers, every message also sends the full extracted text of the active attachments, which counts toward the provider's token quota. Ollama sends requests to your Ollama server.

PDFs need a readable text layer. Run OCR separately for scanned PDFs, then attach the resulting file. The app accepts up to 10 attachments, files up to 20 MB, PDFs up to 300 pages, and up to 60,000 extracted characters across attachments. A conversation can hold up to 100 messages and 100,000 characters. PDFs are parsed in an isolated utility process that is stopped after 60 seconds. If a model sends nothing for 2 minutes, the request stops and keeps any partial reply.

## Develop

```sh
npm test          # unit tests (Vitest)
npm run lint      # ESLint
npm run typecheck # renderer and Electron TypeScript projects
```

The code is split into `electron/` (main process: window, IPC handlers, providers, settings, document extraction), `electron/preload.ts` (the `window.buddy` bridge), `src/` (React UI), and `shared/protocol.ts` (types shared across the IPC boundary). Tests live in `tests/`. CI (`.github/workflows/ci.yml`) runs lint, tests, the build, and a production dependency audit, then packages an unpacked app on Windows, macOS, and Linux.

## Build

```sh
npm run build
npm start
npm run dist
```

`build` type-checks and compiles the Electron and React code. `start` runs that build. `dist` packages the app into `release/` with an NSIS installer on Windows, a DMG on macOS, or an AppImage on Linux. Build on the target OS for release packaging. Packaged builds disable Electron's `RunAsNode`, `NODE_OPTIONS`, and inspector fuses and only load the app from its asar archive. Code signing and notarization are not configured yet. On Linux the widget uses X11, or XWayland on Wayland desktops, for programmatic window positioning. Always-on-top behavior can depend on the window manager.
