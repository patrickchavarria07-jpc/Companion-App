# Architecture

Research Buddy is an Electron app with three kinds of processes and one shared type module.

```
┌──────────────────────────── main process (electron/main.ts) ─────────────────────────────┐
│ window + tray + hotkey · IPC handlers · settings.ts · chat.ts · provider.ts · attachments│
│                    │                                        │                             │
│        utilityProcess.fork (per PDF)               fetch (streaming)                      │
│                    ▼                                        ▼                             │
│     pdf-worker.ts → pdf.ts (pdf.js)          Gemini · Groq · OpenRouter · Ollama · Tavily │
└──────────────────────────────────────▲───────────────────────────────────────────────────┘
                                       │ IPC (contextBridge, validated in main)
┌──────────────── renderer (sandboxed, src/) ─────────────────┐
│ preload.ts exposes window.buddy → React UI (App, Settings)  │
└──────────────────────────────────────────────────────────────┘
```

| Path | Responsibility |
|---|---|
| `electron/main.ts` | Creates the frameless always-on-top window, system tray, and global summon shortcut; positions and drags the window across displays; registers IPC handlers; owns attachments and active stream/extraction controllers. |
| `electron/preload.ts` | Exposes the `window.buddy` API (typed by `Buddy` in `shared/protocol.ts`) to the sandboxed renderer. |
| `electron/validation.ts` | Limits, validation, prefix-stable attachment formatting, and smart query-relevant document excerpting. |
| `electron/chat.ts` | Prepares validated chat requests: sliding-window conversation trimming, document injection, contextual web search queries, and 1-indexed web citations. |
| `electron/attachments.ts` | In-memory attachment store: canonical path deduplication, unique names, count and size limits. |
| `electron/documents.ts` | Reads plain-text research files (`.txt`, `.md`, `.csv`, `.json`, `.bib`, `.tex`, etc. as UTF-8/UTF-16) and hands PDF bytes to a `PdfReader`. |
| `electron/pdf-process.ts`, `pdf-worker.ts`, `pdf.ts` | Parse PDFs with `pdf.js` (including packed CMaps and span-gap reconstruction) in a short-lived utility process killed on completion, abort, or 60 s timeout. |
| `electron/provider.ts`, `stream.ts` | Build provider requests, stream bounded SSE/NDJSON replies, unwrap array/object errors, map status codes, and enforce idle timeouts. |
| `electron/web-search.ts` | Queries Tavily with bounded excerpts, contextualizing short follow-ups and condensing >400-char prompts. |
| `electron/settings.ts` | Serialized atomic reads/writes of `settings.json` in userData, encrypting provider and Tavily API keys with `safeStorage` and surfacing recovery notices when corrupt files are reset. |
| `electron/history.ts` | Serialized atomic read/parse/write of `history.json` in userData, restoring the last conversation on launch. Attachment *text* is intentionally not persisted (it stays in memory only, like the security model assumes); only message text and attachment names survive a restart. |
| `electron/window-state.ts`, `icon.ts` | Computes clamped window/anchor bounds, persists widget position, and renders the RGBA PNG icon. |
| `src/` | React UI. `main.tsx` is the entry, `App.tsx` the chat panel, `SettingsView.tsx` the settings form, `Markdown.tsx` memoized Markdown + inline citation linker. |
| `shared/protocol.ts` | Types, supported extensions, conversation fitting, and constants shared across the IPC boundary. |

## IPC channels

All handlers reject calls that don't come from the app window's main frame, and treat every argument as untrusted.

| Channel | Kind | Arguments → result |
|---|---|---|
| `buddy:expand` | invoke | `open: boolean` → resizes between widget and panel |
| `buddy:drag` | send | `'start' \| 'move' \| 'end'`; the main process reads the cursor position itself and clamps final bounds to the display work area |
| `buddy:hide` | send | — hides the floating window to the system tray without clearing session state |
| `buddy:quit` | send | — |
| `buddy:settings` | invoke | `provider?` → `Settings` (the saved profile for that provider, plus search/Ollama settings and reset flag) |
| `buddy:save` | invoke | `SettingsUpdate` → `Settings` |
| `buddy:attach` | invoke | absolute file path (from `webUtils.getPathForFile`) → `Attachment` |
| `buddy:remove` | invoke | attachment name |
| `buddy:chat` | invoke | `id, Message[], search?` → `ChatResult` (`{ text, error?, sources?, trimmed?, usage? }`) when the reply ends |
| `buddy:cancel` | send | aborts the active reply stream or in-flight PDF extraction |
| `buddy:history` | invoke | — → `History \| null`, the conversation saved from the previous session |
| `buddy:saveHistory` | invoke | `History` → persists the current conversation to `history.json` in userData |
| `buddy:clearHistory` | invoke | — removes any saved conversation |
| `buddy:clipboard` | invoke | — → the OS text selection or clipboard contents, for "ask about this" flows |
| `buddy:chunk` | main → renderer | `{ id, text }` for each streamed piece of the reply |
| `buddy:selection` | main → renderer | `text` when the global shortcut or tray menu pushes selected/clipboard text into the composer |
| `buddy:open` | main → renderer | `open: boolean` when the tray menu or global shortcut expands or collapses the window |

## Chat flow

1. The renderer fits the conversation within context limits (`fitConversation`) and sends it with a fresh request id. `prepareChat` validates and fits it again in the main process.
2. When total attached text fits within 60,000 characters, it is placed on the first user message so follow-up turns share an identical prefix (preserving local Ollama KV caches and hosted prompt caches). When attached documents exceed 60,000 characters (up to 300,000 per document / 600,000 total), `excerptDocument` selects up to 60,000 characters of the most query-relevant pages/sections in document order.
3. If web search is requested, `buildSearchQuery` constructs a `<= 400`-character Tavily query and adds 1-indexed excerpts (`id: 1..5`) to the latest turn.
4. `streamReply` builds the provider request, streams the reply, and forwards each piece as `buddy:chunk` (batched per animation frame in the renderer).
5. The handler resolves with the full text, plus an `error` if the reply failed, was cut off, or was blocked. Partial text is kept.

## Security model

- The renderer is sandboxed, context-isolated, and has no Node access. It can't navigate, open windows, or request permissions. The CSP allows only the app's own scripts.
- Links in replies (including inline `[1]` web citations) open in the system browser, and only for `http`, `https`, and `mailto` URLs (`isExternalUrl`). Raw HTML in replies is shown as text, and images are shown as links.
- Untrusted PDFs are parsed outside the main process (`pdfjs-dist` unpacked from ASAR for isolated `utilityProcess` execution). Extracted document text is labelled as source material, and the default system prompt tells the model not to follow instructions found in it.
- When the window reloads or the renderer crashes, attachments are cleared and active streams/extractions are aborted. That way the main process never holds documents the UI no longer shows.
- Provider and Tavily API keys saved in Settings are stored encrypted with `safeStorage`. Packaged builds disable Electron's `RunAsNode`, `NODE_OPTIONS`, and inspector fuses.

## Testing

Logic lives in modules that don't import Electron (`chat.ts`, `provider.ts`, `validation.ts`, `documents.ts`, `pdf.ts`, `web-search.ts`, `window-state.ts`, `icon.ts`), while `settings.ts` and `pdf-process.ts` run against mocked `electron` modules and `src/` runs against `happy-dom` in Vitest (`tests/`).
