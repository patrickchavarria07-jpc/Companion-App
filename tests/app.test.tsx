// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPrompt, models, type Buddy, type Provider, type Settings, type StreamEvent } from '../shared/protocol';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeSettings(provider: Provider = 'gemini', overrides: Partial<Settings> = {}): Settings {
  return {
    provider,
    model: models[provider],
    systemPrompt: defaultPrompt,
    keySource: provider === 'ollama' ? 'none' : 'saved',
    searchKeySource: 'saved',
    ollamaHost: '',
    ...overrides,
  };
}

let chunkListeners: ((chunk: StreamEvent) => void)[] = [];
let openListeners: ((open: boolean) => void)[] = [];

const buddyMock: Buddy = {
  expand: vi.fn(async () => {}),
  drag: vi.fn(),
  hide: vi.fn(),
  quit: vi.fn(),
  settings: vi.fn(async (provider?: Provider) => makeSettings(provider ?? 'gemini')),
  save: vi.fn(async update => makeSettings(update.provider, {
    model: update.model,
    systemPrompt: update.systemPrompt || defaultPrompt,
    keySource: update.clearKey ? 'none' : 'saved',
    searchKeySource: update.clearTavilyKey ? 'none' : (update.tavilyApiKey ? 'saved' : 'saved'),
    ollamaHost: update.ollamaHost ?? '',
  })),
  attach: vi.fn(async (file: File) => ({ name: file.name, characters: 120 })),
  remove: vi.fn(async () => {}),
  chat: vi.fn(async () => ({ text: 'Final answer [1]', sources: [{ title: 'Source One', url: 'https://example.com/1' }] })),
  cancel: vi.fn(),
  onChunk: callback => {
    chunkListeners.push(callback);
    return () => { chunkListeners = chunkListeners.filter(item => item !== callback); };
  },
  onOpen: callback => {
    openListeners.push(callback);
    return () => { openListeners = openListeners.filter(item => item !== callback); };
  },
};

window.buddy = buddyMock;
const { default: App } = await import('../src/App');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  chunkListeners = [];
  openListeners = [];
  vi.clearAllMocks();
  vi.mocked(buddyMock.settings).mockImplementation(async (provider?: Provider) => makeSettings(provider ?? 'gemini'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function renderOpenedApp() {
  await act(async () => { root.render(<App />); });
  const openBtn = container.querySelector('button[aria-label="Open Research Buddy"]') as HTMLButtonElement;
  expect(openBtn).toBeTruthy();
  await act(async () => { openBtn.click(); });
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('App and SettingsView', () => {
  it('streams a web-search reply, renders linked inline citations, and confirms before clearing or quitting', async () => {
    await renderOpenedApp();

    const textarea = container.querySelector('textarea[aria-label="Your message"]') as HTMLTextAreaElement;
    await act(async () => { setInputValue(textarea, 'Explain the study'); });

    const webSearchBtn = [...container.querySelectorAll('button')].find(btn => btn.textContent === 'Web search')!;
    await act(async () => { webSearchBtn.click(); });

    expect(buddyMock.chat).toHaveBeenCalledOnce();
    const citationLink = container.querySelector('.message.assistant .markdown a[href="https://example.com/1"]');
    expect(citationLink?.textContent).toBe('[1]');

    // Quit asks for confirmation when messages exist, offering Hide to tray.
    const quitBtn = container.querySelector('button[aria-label="Quit"]') as HTMLButtonElement;
    await act(async () => { quitBtn.click(); });
    expect(buddyMock.quit).not.toHaveBeenCalled();
    const hideBtn = [...container.querySelectorAll<HTMLButtonElement>('.confirm-bar button')].find(btn => btn.textContent === 'Hide to tray')!;
    await act(async () => { hideBtn.click(); });
    expect(buddyMock.hide).toHaveBeenCalledOnce();

    // New chat asks for confirmation before clearing.
    const newChatBtn = [...container.querySelectorAll('button')].find(btn => btn.textContent === 'New chat')!;
    await act(async () => { newChatBtn.click(); });
    expect(container.querySelectorAll('.message').length).toBe(2);
    const confirmClear = [...container.querySelectorAll<HTMLButtonElement>('.confirm-bar button')].find(btn => btn.textContent === 'Clear chat')!;
    await act(async () => { confirmClear.click(); });
    expect(container.querySelectorAll('.message').length).toBe(0);
  });

  it('keeps active stream banner and Stop accessible when Settings is opened mid-stream', async () => {
    let resolveChat!: (value: { text: string }) => void;
    vi.mocked(buddyMock.chat).mockImplementationOnce((id) => new Promise(resolve => {
      resolveChat = resolve;
      setTimeout(() => chunkListeners.forEach(fn => fn({ id, text: 'Partial...' })), 0);
    }));

    await renderOpenedApp();
    const textarea = container.querySelector('textarea[aria-label="Your message"]') as HTMLTextAreaElement;
    await act(async () => { setInputValue(textarea, 'Stream test'); });
    const sendBtn = [...container.querySelectorAll('button')].find(btn => btn.textContent === 'Send')!;
    await act(async () => { sendBtn.click(); });

    // Open Settings while stream is still active.
    const settingsBtn = container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
    await act(async () => { settingsBtn.click(); });

    // Conversation section remains mounted (hidden) and active-banner provides Stop button.
    expect(container.querySelector('section.conversation')?.hasAttribute('hidden')).toBe(true);
    const stopBannerBtn = container.querySelector('.active-banner button') as HTMLButtonElement;
    expect(stopBannerBtn?.textContent).toBe('Stop');
    await act(async () => { stopBannerBtn.click(); });
    expect(buddyMock.cancel).toHaveBeenCalledOnce();

    await act(async () => { resolveChat({ text: 'Stopped partial' }); });
  });

  it('preserves unsaved per-provider edits across provider switches and saves Tavily & Ollama settings', async () => {
    await renderOpenedApp();
    const settingsBtn = container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
    await act(async () => { settingsBtn.click(); });

    const modelInput = container.querySelector('.settings input[required]') as HTMLInputElement;
    await act(async () => { setInputValue(modelInput, 'gemini-custom-pro'); });

    const select = container.querySelector('.settings select') as HTMLSelectElement;
    await act(async () => { setInputValue(select, 'ollama'); });
    const hostInput = container.querySelector('.settings input[placeholder="127.0.0.1:11434"]') as HTMLInputElement;
    expect(hostInput).toBeTruthy();
    await act(async () => { setInputValue(hostInput, 'gpu-box:11434'); });

    // Switch back to Gemini: custom model draft is preserved!
    await act(async () => { setInputValue(select, 'gemini'); });
    const restoredModelInput = container.querySelector('.settings input[required]') as HTMLInputElement;
    expect(restoredModelInput.value).toBe('gemini-custom-pro');

    // Save with a new Tavily key and custom Ollama host.
    const passwordInputs = container.querySelectorAll('.settings input[type="password"]');
    const tavilyInput = passwordInputs[1] as HTMLInputElement;
    await act(async () => { setInputValue(tavilyInput, 'tvly-new-secret'); });

    const form = container.querySelector('.settings form') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(buddyMock.save).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-custom-pro',
      tavilyApiKey: 'tvly-new-secret',
      ollamaHost: 'gpu-box:11434',
    }));
  });

  it('surfaces a warning alert when corrupt settings were reset and closes Settings on Escape', async () => {
    vi.mocked(buddyMock.settings).mockResolvedValueOnce(makeSettings('gemini', { wasReset: true }));
    await renderOpenedApp();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('settings file was unreadable');

    const settingsBtn = container.querySelector('button[aria-label="Settings"]') as HTMLButtonElement;
    await act(async () => { settingsBtn.click(); });
    expect(container.querySelector('section.settings')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('section.settings')).toBeNull();
  });
});
