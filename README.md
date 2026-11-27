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

Open **Settings**, select Gemini, Groq, OpenRouter, or Ollama, and enter the model ID. For a hosted provider, add your API key and save. Free model availability, quotas, and account requirements vary by provider. OpenRouter defaults to its free-model router. For Ollama, start the local server and pull the selected model, for example with `ollama pull llama3.2`.

[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Groq models](https://console.groq.com/docs/models) · [OpenRouter free router](https://openrouter.ai/openrouter/free) · [Ollama API](https://docs.ollama.com/api/openai-compatibility)

The app stores keys encrypted with Electron safeStorage in the OS userData directory. On Linux, persistent key storage requires an available system keyring. For development, you can copy `.env.example` to `.env` and fill in the relevant key. A key saved in Settings takes precedence.

Chat and attachments live in memory until you quit. **New chat** clears the messages and keeps attached documents available. With hosted providers, sending a message also sends the extracted text of the active attachments. Ollama sends requests to localhost.

PDFs need a readable text layer. Run OCR separately for scanned PDFs, then attach the resulting file. The app accepts files up to 20 MB, PDFs up to 300 pages, and up to 60,000 extracted characters across attachments.

## Build

```sh
npm run build
npm start
npm run dist
```

`build` type-checks and compiles the Electron and React code. `start` runs that build. `dist` packages the app into `release/` with an NSIS installer on Windows, a DMG on macOS, or an AppImage on Linux. Build on the target OS for release packaging. On Linux the widget uses X11, or XWayland on Wayland desktops, for programmatic window positioning. Always-on-top behavior can depend on the window manager.
