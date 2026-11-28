# Research Buddy

Research Buddy is a floating Electron desktop companion for asking questions, searching the web, and analyzing PDF or plain-text research files (`.pdf`, `.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.bib`, `.tex`, `.yaml`, `.log`). (The repository is named Companion-App; the app is Research Buddy.)

## Run locally

Use Node.js 22.13 or later and npm. From the project folder, run:

```sh
npm install
npm run dev
```

On Windows PowerShell, use `npm.cmd` if script execution is disabled.

Drag the bot to move it. Click it (or press `Ctrl+Shift+Space` / `Cmd+Shift+Space`) to open or toggle chat, and drag the panel by its header. Press `Escape` to close Settings or collapse the panel. Use the system tray icon (or the **Hide to tray** option when closing) to hide the floating widget temporarily without losing your active session.

Drop a PDF or text file onto the bot or panel, or use the `＋` attachment button; click **Cancel** if you need to stop a slow extraction. Files with the same name from different folders are numbered, for example `notes (2).txt`. Once extraction finishes, ask a question or use **Summarize attachments**.

Replies are rendered as Markdown with one-click **Copy**, per-message delete (`×`), and **Export** (`.md`) for the whole conversation. Web links and inline `[1]` citations open in your default browser, and images appear as links rather than loading remote content. If you scroll up while a reply is streaming, the view stays where you are; use **↓ Latest** to jump back down.

The conversation is **saved automatically between sessions** (debounced to `history.json` in the OS userData directory), so quitting and reopening keeps your chat. Documents stay in memory only — after restart, the chat text returns but you'll need to re-attach the source files (a banner reminds you which ones). **New chat** clears and forgets the saved conversation. Token usage (when the provider reports it) is shown in the status line after each reply.

## Ask about what you're reading

Select any text anywhere on your desktop and press `Ctrl+Shift+C` (or `Cmd+Shift+C`), or pick **Ask about clipboard** from the tray menu, or click the **⧉** button in the composer. The selected or copied text is dropped into the composer so you can ask Research Buddy about it without leaving your current window. The floating widget is built for exactly this: ask about whatever you just highlighted.

## Refine replies

Each assistant reply has a **Retry** button to regenerate it, and each of your messages has **Edit** to change the text and re-run the conversation from that point (press `Ctrl/Cmd+Enter` to save, `Esc` to cancel). This makes it easy to iterate on a question without losing the surrounding context.

## Connect a provider

Open **Settings**, select Gemini, Groq, OpenRouter, or Ollama, and enter the model ID. For a hosted provider, add your API key and save. Free model availability, quotas, and account requirements vary by provider. OpenRouter defaults to its free-model router. For Ollama, start the local server and pull the selected model, for example with `ollama pull llama3.2`. The app talks to `127.0.0.1:11434` by default; enter a custom **Ollama host** in Settings (or set `OLLAMA_HOST`, for example `OLLAMA_HOST=gpu-box:11434`) to use another address. When attachments make a request larger than Ollama's default context window, the app raises `num_ctx` based on the UTF-8 byte size of the prompt so documents (including CJK text) are not silently truncated. Larger windows use more memory.

Leave the system prompt blank to use the built-in default.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Groq models](https://console.groq.com/docs/models) · [OpenRouter free router](https://openrouter.ai/openrouter/free) · [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)

The app stores provider and Tavily keys encrypted with Electron `safeStorage` in `settings.json` in the OS userData directory (`%APPDATA%\Research Buddy` on Windows, `~/Library/Application Support/Research Buddy` on macOS, `~/.config/Research Buddy` on Linux). On Linux, persistent key storage requires an available system keyring. If the settings file becomes unreadable, the app moves it aside as `settings.json.corrupt-<timestamp>`, starts with defaults, and shows an alert prompting you to re-enter saved keys.

The app also reads `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `TAVILY_API_KEY` from the environment, in both development and packaged builds. Settings shows when an environment key is in use, and a key saved in Settings takes precedence. In development (`npm run dev`), the app also loads these from a `.env` file; copy `.env.example` to get started.

Chat is saved automatically and restored the next time you open the app; attached documents live in memory until you quit or reload the window. **New chat** clears the messages (after confirmation) and forgets the saved conversation, while keeping in-memory attached documents available for the current session. Attachments totaling up to 60,000 characters are placed at the start of the conversation so follow-up questions can reuse provider/Ollama KV caches; larger documents (up to 300,000 characters per document and 600,000 characters across up to 10 attachments) automatically select up to 60,000 characters of the most relevant pages or sections per question.

PDFs need a readable text layer. Run OCR separately for scanned PDFs, then attach the resulting file. The app accepts up to 10 attachments, files up to 20 MB, and PDFs up to 300 pages. Up to 100 recent messages / 100,000 conversation characters are sent per turn, automatically omitting older turns when a long conversation grows past the limit. PDFs are parsed in an isolated utility process that can be cancelled at any time and is stopped after 60 seconds. If a model sends nothing for 2 minutes, the request stops and keeps any partial reply.

## Search the web

Get a [Tavily API key](https://app.tavily.com/) and save it under **Web search API key (Tavily)** in **Settings** (or set `TAVILY_API_KEY` in `.env` / your environment).

Type a question and click **Web search**. Short follow-up questions automatically include topic context from your previous turn, and questions longer than 400 characters are condensed into a 400-character search query while sending your full prompt to the chat model. The selected chat model receives 1-indexed excerpts from up to five results alongside your chat context. Inline citations like `[1]` and the **Web sources** list below the reply open directly in your browser. **Send** and Enter use regular chat. Each search uses one basic Tavily search credit.

## Develop

```sh
npm run dev       # hot reload: UI edits update in place, main-process edits restart the app
npm test          # unit and component tests (Vitest)
npm run lint      # ESLint
npm run typecheck # renderer and Electron TypeScript projects
```

The code is split into `electron/` (main process: window, tray, IPC handlers, chat preparation, providers, settings, document extraction), `electron/preload.ts` (the `window.buddy` bridge), `src/` (React UI), and `shared/protocol.ts` (types and helpers shared across the IPC boundary). Tests live in `tests/`. CI (`.github/workflows/ci.yml`) runs lint, tests, the build, and a production dependency audit, then packages and verifies an unpacked app on Windows, macOS, and Linux.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull request checklist, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for processes, IPC channels, and the security model.

## Build

```sh
npm run build
npm start
npm run dist
```

`build` cleans old output, type-checks, and compiles the Electron and React code. `start` builds and then runs the app. `dist` packages the app into `release/` with an NSIS installer on Windows, a DMG on macOS, or an AppImage on Linux. Build on the target OS for release packaging. Packaged builds unpack `pdfjs-dist` for the isolated utility process, disable Electron's `RunAsNode`, `NODE_OPTIONS`, and inspector fuses, and only load the app from its asar archive. Code signing and notarization are not configured yet. On Linux the widget uses X11, or XWayland on Wayland desktops, for programmatic window positioning. Always-on-top behavior can depend on the window manager.

## Troubleshooting

- **"Unlock or configure your system keyring" on Linux.** Saving a key needs a Secret Service keyring, such as GNOME Keyring or KWallet. Install one and unlock it, or set the provider's `*_API_KEY` environment variable instead.
- **"Could not unlock your saved API key".** The keyring that encrypted the key is unavailable or has changed. Unlock it, or enter the key again in Settings.
- **Settings were reset.** The settings file was unreadable. An in-app warning alerts you when this happens, and the old copy is saved next to the new one as `settings.json.corrupt-<timestamp>` (see the folders above).
- **The widget doesn't appear or can't be positioned on Linux.** The app runs through X11. On Wayland, make sure XWayland is available. Always-on-top behavior depends on the window manager.
- **The widget is off-screen after unplugging a monitor.** Research Buddy listens for display changes and pulls the widget onto the nearest active display automatically. To reset the saved position manually, delete `window-state.json` from the settings folder.
- **"Could not connect to Ollama".** Start Ollama (`ollama serve`), check **Ollama host** in Settings (or `OLLAMA_HOST`), and pull the model you selected.
- **"No readable text found".** The PDF is probably scanned. Run OCR on it first.
- **Rate limit or credits errors.** Free tiers have quotas. Wait, pick another model, or remove unused attachments.

## License

[MIT](LICENSE)
