import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { extract, maxContext } from './documents';
import { getKey, getSettings, isProvider, saveSettings } from './settings';
import { streamReply } from './provider';
import type { ChatResult, Message, SettingsUpdate } from '../shared/protocol';

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
const attachments = new Map<string, string>();
let extracting = false;
let saving = false;

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
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { stream?.abort(); attachments.clear(); window = null; });
  if (development) void window.loadURL('http://127.0.0.1:5173');
  else void window.loadFile(join(__dirname, '../../dist/index.html'));
}

function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame;
}

function handle<T extends unknown[], R>(channel: string, callback: (...args: T) => R) {
  ipcMain.handle(channel, (event, ...args: T) => {
    if (!trusted(event)) throw new Error('Request denied.');
    return callback(...args);
  });
}

handle('buddy:expand', (open: boolean) => {
  if (!window || expanded === open) return;
  if (!expanded) {
    const { x, y } = window.getBounds();
    anchor = { x, y };
  }
  expanded = open;
  position(open);
});
ipcMain.on('buddy:drag', (event, phase: string) => {
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
handle('buddy:settings', (provider?: unknown) => getSettings(isProvider(provider) ? provider : undefined));
handle('buddy:save', async (settings: SettingsUpdate) => {
  if (saving) throw new Error('Settings are already being saved.');
  saving = true;
  try { return await saveSettings(settings); } finally { saving = false; }
});
handle('buddy:attach', async (path: string) => {
  if (extracting || stream) throw new Error('Wait for the current operation to finish.');
  extracting = true;
  try {
    const { name, text } = await extract(path);
    if (attachments.has(name)) throw new Error('A document with this name is already attached.');
    const used = [...attachments.values()].reduce((total, item) => total + item.length, 0);
    if (used + text.length > maxContext || attachments.size >= 10) {
      throw new Error('Attachment limit reached. Remove a document before adding another.');
    }
    attachments.set(name, text);
    return { name, characters: text.length };
  } finally { extracting = false; }
});
handle('buddy:remove', (name: string) => { attachments.delete(name); });
handle('buddy:chat', async (id: string, messages: Message[]): Promise<ChatResult> => {
  if (stream || extracting) throw new Error('Wait for the current operation to finish.');
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 ||
      messages.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') ||
      messages.at(-1)?.role !== 'user' || messages.reduce((total, message) => total + message.content.length, 0) > 100_000) {
    throw new Error('This conversation is too long. Start a new chat.');
  }
  const controller = new AbortController();
  stream = controller;
  const timeout = AbortSignal.timeout(180_000);
  let reply = '';
  try {
    const settings = await getSettings();
    const key = await getKey(settings.provider);
    const context = [...attachments].map(([name, text]) => ({ name, text }));
    const request = [...messages];
    if (context.length) {
      request[request.length - 1] = {
        role: 'user',
        content: 'Attached source material (JSON):\n' + JSON.stringify(context) + '\n\nUser request:\n' + request.at(-1)!.content,
      };
    }
    await streamReply(settings, key, request, AbortSignal.any([controller.signal, timeout]), text => {
      reply += text;
      if (window && !window.isDestroyed()) window.webContents.send('buddy:chunk', { id, text });
    });
    return { text: reply };
  } catch (error) {
    if (controller.signal.aborted) return { text: reply };
    if (timeout.aborted) return { text: reply, error: 'The model took too long to reply. Try again.' };
    return { text: reply, error: error instanceof Error ? error.message : 'Could not complete the request.' };
  } finally { stream = undefined; }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(createWindow);
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
