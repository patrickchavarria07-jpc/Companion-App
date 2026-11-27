# Research Buddy

Research Buddy is a floating Electron desktop companion for asking questions and analyzing PDF or TXT files. (The repository is named Companion-App; the app is Research Buddy.)

## Run locally

Use Node.js 22.13 or later and npm. From the project folder, run:

```sh
npm install
npm run dev
```

On Windows PowerShell, use `npm.cmd` if script execution is disabled.

Drag the bot to move it. Click it to open chat, and drag the panel by its header. The app remembers where you left it. Drop a PDF or TXT onto the bot or panel, or use the attachment button. Files with the same name from different folders are numbered, for example `notes (2).txt`. Once extraction finishes, ask a question or use **Summarize attachments**. The header lets you open Settings, collapse the panel, or quit.

Replies are rendered as Markdown. Web links open in your default browser, and images appear as links rather than loading remote content. If you scroll up while a reply is streaming, the view stays where you are; use **↓ Latest** to jump back down.

## Connect a provider

Open **Settings**, select Gemini, Groq, OpenRouter, or Ollama, and enter the model ID. For a hosted provider, add your API key and save. Free model availability, quotas, and account requirements vary by provider. OpenRouter defaults to its free-model router. For Ollama, start the local server and pull the selected model, for example with `ollama pull llama3.2`. The app talks to `127.0.0.1:11434` by default; set `OLLAMA_HOST` (for example `OLLAMA_HOST=gpu-box:11434`) to use another address. When attachments make a request larger than Ollama's default context window, the app raises `num_ctx` for that request so documents are not silently truncated. Larger windows use more memory.

Leave the system prompt blank to use the built-in default.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Groq models](https://console.groq.com/docs/models) · [OpenRouter free router](https://openrouter.ai/openrouter/free) · [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)

The app stores keys encrypted with Electron safeStorage in `settings.json` in the OS userData directory (`%APPDATA%\Research Buddy` on Windows, `~/Library/Application Support/Research Buddy` on macOS, `~/.config/Research Buddy` on Linux). On Linux, persistent key storage requires an available system keyring. If the settings file becomes unreadable, the app moves it aside as `settings.json.corrupt-<timestamp>` and starts with defaults, so you need to re-enter your key.

The app also reads `GEMINI_API_KEY`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` from the environment, in both development and packaged builds. Settings shows when an environment key is in use. A key saved in Settings takes precedence. In development (`npm run dev`), the app also loads these from a `.env` file; copy `.env.example` to get started.

Chat and attachments live in memory until you quit or the window reloads. **New chat** clears the messages and keeps attached documents available. With hosted providers, every message also sends the full extracted text of the active attachments, which counts toward the provider's token quota. Ollama sends requests to your Ollama server.

PDFs need a readable text layer. Run OCR separately for scanned PDFs, then attach the resulting file. The app accepts up to 10 attachments, files up to 20 MB, PDFs up to 300 pages, and up to 60,000 extracted characters across attachments. A conversation can hold up to 100 messages and 100,000 characters. PDFs are parsed in an isolated utility process that is stopped after 60 seconds. If a model sends nothing for 2 minutes, the request stops and keeps any partial reply.

## Search the web

Get a [Tavily API key](https://app.tavily.com/) to use live web results alongside your existing chat model. For `npm run dev`, add `TAVILY_API_KEY=your_key_here` to your local `.env` file (create it from `.env.example` if needed). For `npm start` or an installed build, set `TAVILY_API_KEY` in the environment that launches the app. Restart Research Buddy after setting the key.

Type a question of up to 400 characters and click **Web search**. Tavily receives the current question. The selected chat model receives excerpts from up to five results, along with the usual chat context. Numbered citations refer to the clickable **Web sources** below the reply. **Send** and Enter use regular chat. Each search uses one basic Tavily search credit.

## Develop

```sh
npm run dev       # hot reload: UI edits update in place, main-process edits restart the app
npm test          # unit tests (Vitest)
npm run lint      # ESLint
npm run typecheck # renderer and Electron TypeScript projects
```

The code is split into `electron/` (main process: window, IPC handlers, providers, settings, document extraction), `electron/preload.ts` (the `window.buddy` bridge), `src/` (React UI), and `shared/protocol.ts` (types shared across the IPC boundary). Tests live in `tests/`. CI (`.github/workflows/ci.yml`) runs lint, tests, the build, and a production dependency audit, then packages an unpacked app on Windows, macOS, and Linux.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull request checklist, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for processes, IPC channels, and the security model.

## Build

```sh
npm run build
npm start
npm run dist
```

`build` cleans old output, type-checks, and compiles the Electron and React code. `start` builds and then runs the app. `dist` packages the app into `release/` with an NSIS installer on Windows, a DMG on macOS, or an AppImage on Linux. Build on the target OS for release packaging. Packaged builds disable Electron's `RunAsNode`, `NODE_OPTIONS`, and inspector fuses and only load the app from its asar archive. Code signing and notarization are not configured yet. On Linux the widget uses X11, or XWayland on Wayland desktops, for programmatic window positioning. Always-on-top behavior can depend on the window manager.

## Troubleshooting

- **"Unlock or configure your system keyring" on Linux.** Saving a key needs a Secret Service keyring, such as GNOME Keyring or KWallet. Install one and unlock it, or set the provider's `*_API_KEY` environment variable instead.
- **"Could not unlock your saved API key".** The keyring that encrypted the key is unavailable or has changed. Unlock it, or enter the key again in Settings.
- **Settings were reset.** The settings file was unreadable. The old copy is next to the new one as `settings.json.corrupt-<timestamp>` (see the folders above).
- **The widget doesn't appear or can't be positioned on Linux.** The app runs through X11. On Wayland, make sure XWayland is available. Always-on-top behavior depends on the window manager.
- **The widget is off-screen after unplugging a monitor.** It is moved onto the nearest display at the next launch. To reset the saved position, delete `window-state.json` from the settings folder.
- **"Could not connect to Ollama".** Start Ollama (`ollama serve`), check `OLLAMA_HOST` if you use a non-default address, and pull the model you selected.
- **"No readable text found".** The PDF is probably scanned. Run OCR on it first.
- **Rate limit or credits errors.** Free tiers have quotas. Wait, pick another model, or use a smaller attachment, since the full attachment text is sent with every message.

## License

[MIT](LICENSE)
