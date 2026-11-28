import {
  app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray,
} from 'electron';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { AttachmentStore } from './attachments';
import { prepareChat } from './chat';
import { extract } from './documents';
import { renderBotPng } from './icon';
import { readPdfInUtilityProcess } from './pdf-process';
import { streamReply } from './provider';
import { getKey, getSearchKey, getSettings, isProvider, saveSettings } from './settings';
import { isExternalUrl, isRequestId, validateAttachmentPath } from './validation';
import { anchorFromBounds, clampToArea, computeWindowBounds, createPositionStore } from './window-state';
import type { ChatResult, SettingsUpdate } from '../shared/protocol';

const development = !app.isPackaged && process.argv.includes('--dev');
if (development) {
  try { loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Research Buddy: could not parse .env file:', error);
    }
  }
}
app.setName('Research Buddy');
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

const compact = { width: 104, height: 104 };
const panelSize = { width: 460, height: 650 };
const summonShortcut = 'CommandOrControl+Shift+Space';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let creating: Promise<void> | undefined;
let expanded = false;
let anchor = { x: 0, y: 0 };
let stream: AbortController | undefined;
let extraction: AbortController | undefined;
let dragging: { x: number; y: number; bounds: Electron.Rectangle } | undefined;
const attachments = new AttachmentStore();
/** Incremented whenever the renderer starts over, so in-flight work for the old page is discarded. */
let session = 0;
const positions = createPositionStore(join(app.getPath('userData'), 'window-state.json'));

function position(open: boolean) {
  if (!window || window.isDestroyed()) return;
  const current = window.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({
    x: anchor.x + compact.width / 2,
    y: anchor.y + compact.height / 2,
  });
  const next = computeWindowBounds(anchor, compact, panelSize, open, workArea);
  if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) {
    window.setBounds(next);
  }
}

function anchorFromWindow() {
  if (!window || window.isDestroyed()) return;
  anchor = anchorFromBounds(window.getBounds(), compact, expanded);
}

function rememberPosition() {
  void positions.save(anchor);
}

function setExpanded(open: boolean, notifyRenderer = false) {
  if (!window || window.isDestroyed() || expanded === open) return;
  if (!expanded) anchorFromWindow();
  expanded = open;
  position(open);
  if (!open) rememberPosition();
  if (notifyRenderer) window.webContents.send('buddy:open', open);
}

function keepWindowOnScreen() {
  if (!window || window.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching({ ...anchor, ...compact });
  anchor = clampToArea(anchor, compact, workArea);
  position(expanded);
  rememberPosition();
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = Boolean(window && !window.isDestroyed() && window.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Research Buddy',
      accelerator: summonShortcut,
      click: () => summonWindow(true),
    },
    {
      label: visible ? 'Hide Widget' : 'Show Widget',
      click: () => {
        if (!window || window.isDestroyed()) {
          ensureWindow();
          return;
        }
        if (window.isVisible()) window.hide();
        else { window.show(); window.focus(); }
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit Research Buddy', click: () => app.quit() },
  ]));
}

function summonWindow(forceOpen = false) {
  if (!window || window.isDestroyed()) {
    ensureWindow();
    return;
  }
  if (!window.isVisible()) {
    window.show();
    setExpanded(true, true);
    window.focus();
  } else if (!expanded || forceOpen) {
    setExpanded(true, true);
    window.focus();
  } else if (!window.isFocused()) {
    window.focus();
  } else {
    setExpanded(false, true);
  }
  updateTrayMenu();
}

/**
 * The renderer keeps the visible attachment list and conversation in memory. When the page reloads
 * or crashes, drop main-process state too so hidden documents are never sent to a provider.
 */
function resetSession() {
  session++;
  stream?.abort();
  extraction?.abort();
  attachments.clear();
  dragging = undefined;
  if (window && !window.isDestroyed() && expanded) {
    expanded = false;
    position(false);
  }
}

async function createWindow() {
  const saved = await positions.load();
  if (saved) {
    anchor = clampToArea(saved, compact, screen.getDisplayMatching({ ...saved, ...compact }).workArea);
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    anchor = { x: area.x + area.width - 126, y: area.y + area.height - 126 };
  }
  expanded = false;
  window = new BrowserWindow({
    ...compact,
    ...anchor,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    icon: nativeImage.createFromBuffer(renderBotPng(64)),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-start-loading', resetSession);
  window.webContents.on('render-process-gone', resetSession);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  window.once('ready-to-show', () => { window?.show(); updateTrayMenu(); });
  window.on('show', updateTrayMenu);
  window.on('hide', updateTrayMenu);
  window.on('closed', () => { resetSession(); window = null; updateTrayMenu(); });
  if (development) void window.loadURL('http://127.0.0.1:5173');
  else void window.loadFile(join(__dirname, '../../dist/index.html'));
}

function ensureWindow() {
  if (window || creating) return;
  creating = createWindow().finally(() => { creating = undefined; });
}

function createTray() {
  try {
    const image = nativeImage.createFromBuffer(renderBotPng(32)).resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip('Research Buddy (' + summonShortcut.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl') + ')');
    tray.on('click', () => summonWindow());
    updateTrayMenu();
  } catch {
    // Tray may be unavailable in headless desktop environments.
  }
}

function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame;
}

/** Registers an IPC handler for the trusted main frame. Arguments are untrusted and must be validated. */
function handle(channel: string, callback: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error('Request denied.');
    return callback(...args);
  });
}

handle('buddy:expand', open => {
  if (typeof open !== 'boolean') throw new Error('Invalid request.');
  setExpanded(open, false);
});
ipcMain.on('buddy:drag', (event, phase: unknown) => {
  if (!trusted(event) || !window) return;
  if (phase === 'end') {
    if (!dragging) return;
    const raw = window.getBounds();
    const moved = raw.x !== dragging.bounds.x || raw.y !== dragging.bounds.y;
    dragging = undefined;
    if (moved) {
      const { workArea } = screen.getDisplayNearestPoint({
        x: raw.x + Math.round(raw.width / 2),
        y: raw.y + Math.round(raw.height / 2),
      });
      const clamped = clampToArea(raw, { width: raw.width, height: raw.height }, workArea);
      if (clamped.x !== raw.x || clamped.y !== raw.y) {
        window.setBounds({ ...clamped, width: raw.width, height: raw.height });
      }
      anchorFromWindow();
      rememberPosition();
    }
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  if (phase === 'start') { dragging = { ...cursor, bounds: window.getBounds() }; return; }
  if (phase === 'move' && dragging) {
    const { bounds } = dragging;
    window.setBounds({
      x: bounds.x + cursor.x - dragging.x,
      y: bounds.y + cursor.y - dragging.y,
      width: bounds.width,
      height: bounds.height,
    });
  }
});
ipcMain.on('buddy:hide', event => {
  if (!trusted(event) || !window) return;
  window.hide();
  updateTrayMenu();
});
ipcMain.on('buddy:quit', event => { if (trusted(event)) app.quit(); });
ipcMain.on('buddy:cancel', event => {
  if (!trusted(event)) return;
  stream?.abort();
  extraction?.abort();
});
handle('buddy:settings', provider => getSettings(isProvider(provider) ? provider : undefined));
handle('buddy:save', settings => saveSettings(settings as SettingsUpdate));
handle('buddy:attach', async input => {
  const path = validateAttachmentPath(input);
  if (extraction || stream) throw new Error('Wait for the current operation to finish.');
  const controller = new AbortController();
  extraction = controller;
  const started = session;
  try {
    const resolved = await realpath(path).catch(() => path);
    const { name, text } = await extract(
      path,
      bytes => readPdfInUtilityProcess(bytes, controller.signal),
      controller.signal,
    );
    if (started !== session) throw new Error('The window reloaded. Attach the file again.');
    return attachments.add(name, text, resolved);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Attachment cancelled.', { cause: error });
    throw error;
  } finally {
    if (extraction === controller) extraction = undefined;
  }
});
handle('buddy:remove', name => {
  if (typeof name !== 'string') throw new Error('Invalid request.');
  attachments.remove(name);
});
handle('buddy:chat', async (id, input, search = false): Promise<ChatResult> => {
  if (!isRequestId(id) || typeof search !== 'boolean') throw new Error('Invalid chat request.');
  if (stream || extraction) throw new Error('Wait for the current operation to finish.');
  const controller = new AbortController();
  stream = controller;
  let reply = '';
  let sources: ChatResult['sources'];
  let trimmed = 0;
  try {
    const settings = await getSettings();
    const key = await getKey(settings.provider);
    if (settings.provider !== 'ollama' && !key) throw new Error('Add an API key in Settings before sending a message.');
    const searchKey = search ? await getSearchKey() : undefined;
    controller.signal.throwIfAborted();
    const prepared = await prepareChat({
      input,
      attachments: attachments.list(),
      systemPrompt: settings.systemPrompt,
      search,
      signal: controller.signal,
      searchKey,
    });
    sources = prepared.sources;
    trimmed = prepared.trimmed;
    controller.signal.throwIfAborted();
    await streamReply({ ...settings, systemPrompt: prepared.systemPrompt }, key, prepared.request, {
      signal: controller.signal,
      onText: text => {
        reply += text;
        if (window && !window.isDestroyed()) window.webContents.send('buddy:chunk', { id, text });
      },
    });
    return { text: reply, sources, ...(trimmed ? { trimmed } : {}) };
  } catch (error) {
    if (controller.signal.aborted) return { text: reply, sources, ...(trimmed ? { trimmed } : {}) };
    if (development) console.error('[buddy:chat]', error);
    return {
      text: reply,
      sources,
      ...(trimmed ? { trimmed } : {}),
      error: error instanceof Error ? error.message : 'Could not complete the request.',
    };
  } finally {
    if (stream === controller) stream = undefined;
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => summonWindow(true));
  void app.whenReady().then(() => {
    if (!development) {
      Menu.setApplicationMenu(process.platform === 'darwin'
        ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
        : null);
    }
    createTray();
    screen.on('display-removed', keepWindowOnScreen);
    screen.on('display-metrics-changed', keepWindowOnScreen);
    try { globalShortcut.register(summonShortcut, () => summonWindow()); } catch { /* shortcut in use */ }
    ensureWindow();
  });
  app.on('activate', () => summonWindow(true));
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
