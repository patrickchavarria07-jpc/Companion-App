# Architecture

Research Buddy is an Electron app with three kinds of processes and one shared type module.

```
┌──────────────────────────── main process (electron/main.ts) ─────────────────────────────┐
│ window + position · IPC handlers · settings.ts · provider.ts · attachments in memory    │
│                    │                                        │                             │
│        utilityProcess.fork (per PDF)               fetch (streaming)                      │
│                    ▼                                        ▼                             │
│     pdf-worker.ts → pdf.ts (pdf.js)          Gemini · Groq · OpenRouter · Ollama          │
└──────────────────────────────────────▲───────────────────────────────────────────────────┘
                                       │ IPC (contextBridge, validated in main)
┌──────────────── renderer (sandboxed, src/) ─────────────────┐
│ preload.ts exposes window.buddy → React UI (App, Settings)  │
└──────────────────────────────────────────────────────────────┘
```

| Path | Responsibility |
|---|---|
| `electron/main.ts` | Creates the frameless always-on-top window, positions and drags it, registers IPC handlers, owns attachments and the active stream. |
| `electron/preload.ts` | Exposes the `window.buddy` API (typed by `Buddy` in `shared/protocol.ts`) to the sandboxed renderer. |
| `electron/validation.ts` | Limits and validation for every untrusted value that arrives over IPC. |
| `electron/attachments.ts` | In-memory attachment store: unique names, count and size limits. |
| `electron/documents.ts` | Reads TXT files (UTF-8/UTF-16) and hands PDF bytes to a `PdfReader`. |
| `electron/pdf-process.ts`, `pdf-worker.ts`, `pdf.ts` | Parse PDFs with pdf.js in a short-lived utility process (killed after 60 s). |
| `electron/provider.ts`, `stream.ts` | Build provider requests, stream SSE/NDJSON replies, map errors, idle timeout. |
| `electron/settings.ts` | `settings.json` in userData, API keys encrypted with `safeStorage`, recovery from corrupt files. |
| `electron/window-state.ts` | Remembers the widget position between launches. |
| `src/` | React UI. `main.tsx` is the entry, `App.tsx` the chat panel, `SettingsView.tsx` the settings form, `Markdown.tsx` renders replies. |
| `shared/protocol.ts` | Types and constants shared by both sides of the IPC boundary. |

## IPC channels

All handlers reject calls that don't come from the app window's main frame, and treat every argument as untrusted.

| Channel | Kind | Arguments → result |
|---|---|---|
| `buddy:expand` | invoke | `open: boolean` → resizes between widget and panel |
| `buddy:drag` | send | `'start' \| 'move' \| 'end'`; the main process reads the cursor position itself |
| `buddy:quit` | send | — |
| `buddy:settings` | invoke | `provider?` → `Settings` (the saved profile for that provider) |
| `buddy:save` | invoke | `SettingsUpdate` → `Settings` |
| `buddy:attach` | invoke | absolute file path (from `webUtils.getPathForFile`) → `Attachment` |
| `buddy:remove` | invoke | attachment name |
| `buddy:chat` | invoke | `id, Message[], search?` → `ChatResult` (`{ text, error?, sources? }`) when the reply ends |
| `buddy:cancel` | send | aborts the active reply |
| `buddy:chunk` | main → renderer | `{ id, text }` for each streamed piece of the reply |

## Chat flow

1. The renderer sends the whole conversation with a fresh request id. The main process validates it (`validateMessages`).
2. The text of all attachments is added, as JSON, to the latest user message only (`withAttachments`).
3. `streamReply` builds the provider request, streams the reply, and forwards each piece as `buddy:chunk`.
4. The handler resolves with the full text, plus an `error` if the reply failed, was cut off, or was blocked. Partial text is kept.

## Security model

- The renderer is sandboxed, context-isolated, and has no Node access. It can't navigate, open windows, or request permissions. The CSP allows only the app's own scripts.
- Links in replies open in the system browser, and only for `http`, `https`, and `mailto` URLs (`isExternalUrl`). Raw HTML in replies is shown as text, and images are shown as links.
- Untrusted PDFs are parsed outside the main process. Extracted document text is labelled as source material, and the default system prompt tells the model not to follow instructions found in it.
- When the window reloads or the renderer crashes, attachments are cleared and the active reply is aborted. That way the main process never holds documents the UI no longer shows.
- API keys saved in Settings are stored encrypted. Tavily uses the main process's `TAVILY_API_KEY` environment variable. An opt-in search sends the latest question to Tavily and adds bounded excerpts to the model request as untrusted source material. Packaged builds disable Electron's `RunAsNode`, `NODE_OPTIONS`, and inspector fuses.

## Testing

Logic lives in modules that don't import Electron, so Vitest can test it directly (`tests/`). Network calls use a stubbed `fetch`, PDFs are generated on the fly, and `settings.ts` runs against a mocked `electron` module. The Electron wiring in `main.ts`, `preload.ts`, and `pdf-process.ts` is kept thin. It is checked by packaging in CI and by the manual checks in `CONTRIBUTING.md`.
