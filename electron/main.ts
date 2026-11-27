import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { AttachmentStore } from './attachments';
import { extract } from './documents';
import { readPdfInUtilityProcess } from './pdf-process';
import { getKey, getSettings, isProvider, saveSettings } from './settings';
import { streamReply } from './provider';
import { isRequestId, validateAttachmentPath, validateMessages, withAttachments } from './validation';
import type { ChatResult, SettingsUpdate } from '../shared/protocol';

const development = !app.isPackaged && process.argv.includes('--dev');
if (development) {
  try { loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
app.setName('Research Buddy');
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

const compact = { width: 104, height: 104 };
let window: BrowserWindow | null = null;
let expanded = false;
let anchor = { x: 0, y: 0 };
let stream: AbortController | undefined;
let dragging: { x: number; y: number; bounds: Electron.Rectangle } | undefined;
const attachments = new AttachmentStore();
let extracting = false;
let saving = false;
/** Incremented whenever the renderer starts over, so in-flight work for the old page is discarded. */
let session = 0;

function position(open: boolean) {
  if (!window) return;
  const current = window.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({ x: anchor.x + compact.width / 2, y: anchor.y + compact.height / 2 });
  const width = open ? Math.min(460, workArea.width) : compact.width;
  const height = open ? Math.min(650, workArea.height) : compact.height;
  const target = open ? { x: anchor.x + compact.width - width, y: anchor.y + compact.height - height } : anchor;
  const x = Math.max(workArea.x, Math.min(target.x, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(target.y, workArea.y + workArea.height - height));
  if (current.x !== x || current.y !== y || current.width !== width || current.height !== height) {
    window.setBounds({ x, y, width, height });
  }
}

/**
 * The renderer keeps the visible attachment list and conversation in memory. When the page reloads
 * or crashes, drop main-process state too so hidden documents are never sent to a provider.
 */
function resetSession() {
  session++;
  stream?.abort();
  attachments.clear();
  dragging = undefined;
  if (window && !window.isDestroyed() && expanded) {
    expanded = false;
    position(false);
  }
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  anchor = { x: area.x + area.width - 126, y: area.y + area.height - 126 };
  expanded = false;
  window = new BrowserWindow({
    ...compact, ...anchor, frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    maximizable: false, fullscreenable: false, hasShadow: false, acceptFirstMouse: true, show: false,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-start-loading', resetSession);
  window.webContents.on('render-process-gone', resetSession);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { resetSession(); window = null; });
  if (development) void window.loadURL('http://127.0.0.1:5173');
  else void window.loadFile(join(__dirname, '../../dist/index.html'));
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
  if (!window || expanded === open) return;
  if (!expanded) {
    const { x, y } = window.getBounds();
    anchor = { x, y };
  }
  expanded = open;
  position(open);
});
ipcMain.on('buddy:drag', (event, phase: unknown) => {
  if (!trusted(event) || !window || expanded) return;
  if (phase === 'end') { dragging = undefined; return; }
  const cursor = screen.getCursorScreenPoint();
  if (phase === 'start') { dragging = { ...cursor, bounds: window.getBounds() }; return; }
  if (phase === 'move' && dragging) {
    window.setPosition(dragging.bounds.x + cursor.x - dragging.x, dragging.bounds.y + cursor.y - dragging.y);
  }
});
ipcMain.on('buddy:quit', event => { if (trusted(event)) app.quit(); });
ipcMain.on('buddy:cancel', event => { if (trusted(event)) stream?.abort(); });
handle('buddy:settings', provider => getSettings(isProvider(provider) ? provider : undefined));
handle('buddy:save', async settings => {
  if (saving) throw new Error('Settings are already being saved.');
  saving = true;
  try { return await saveSettings(settings as SettingsUpdate); } finally { saving = false; }
});
handle('buddy:attach', async input => {
  const path = validateAttachmentPath(input);
  if (extracting || stream) throw new Error('Wait for the current operation to finish.');
  extracting = true;
  const started = session;
  try {
    const { name, text } = await extract(path, readPdfInUtilityProcess);
    if (started !== session) throw new Error('The window reloaded. Attach the file again.');
    return attachments.add(name, text);
  } finally { extracting = false; }
});
handle('buddy:remove', name => {
  if (typeof name !== 'string') throw new Error('Invalid request.');
  attachments.remove(name);
});
handle('buddy:chat', async (id, input): Promise<ChatResult> => {
  if (!isRequestId(id)) throw new Error('Invalid chat request.');
  if (stream || extracting) throw new Error('Wait for the current operation to finish.');
  const messages = validateMessages(input);
  const controller = new AbortController();
  stream = controller;
  let reply = '';
  try {
    const settings = await getSettings();
    const key = await getKey(settings.provider);
    await streamReply(settings, key, withAttachments(messages, attachments.list()), {
      signal: controller.signal,
      onText: text => {
        reply += text;
        if (window && !window.isDestroyed()) window.webContents.send('buddy:chunk', { id, text });
      },
    });
    return { text: reply };
  } catch (error) {
    if (controller.signal.aborted) return { text: reply };
    if (development) console.error('[buddy:chat]', error);
    return { text: reply, error: error instanceof Error ? error.message : 'Could not complete the request.' };
  } finally {
    if (stream === controller) stream = undefined;
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(() => {
    // Electron's default menu adds Reload and DevTools shortcuts. Keep them for development only;
    // on macOS keep the app and edit menus so Quit and copy/paste shortcuts keep working.
    if (!development) {
      Menu.setApplicationMenu(process.platform === 'darwin'
        ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
        : null);
    }
    createWindow();
  });
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
