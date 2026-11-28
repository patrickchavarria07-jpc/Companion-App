import { app, safeStorage } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  defaultPrompt, envKeyName, models, providers, type KeySource, type Provider, type Settings, type SettingsUpdate,
} from '../shared/protocol';
import { ollamaBaseUrl } from './provider';
import { isRecord } from './validation';

type Profile = { model: string; systemPrompt: string; key?: string };
type Config = {
  provider: Provider;
  profiles: Partial<Record<Provider, Profile>>;
  tavilyKey?: string;
  ollamaHost?: string;
};

export const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const defaults = (): Config => ({ provider: 'gemini', profiles: {} });
const canEncrypt = () => safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
const envKey = (provider: Provider) => provider === 'ollama' ? '' : process.env[envKeyName(provider)]?.trim() || '';
const envSearchKey = () => process.env.TAVILY_API_KEY?.trim() || '';

let queue: Promise<void> = Promise.resolve();
let resetNoticeForPath: string | undefined;

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(models, value);
}

/**
 * Normalizes untrusted settings JSON. Invalid fields fall back to defaults so one bad value
 * never locks the user out. Returns undefined if the value is not a settings object at all.
 */
export function parseConfig(value: unknown): Config | undefined {
  if (!isRecord(value)) return undefined;
  const config: Config = { provider: isProvider(value.provider) ? value.provider : 'gemini', profiles: {} };
  const profiles = isRecord(value.profiles) ? value.profiles : {};
  for (const provider of providers) {
    const raw = profiles[provider];
    if (!isRecord(raw)) continue;
    const model = typeof raw.model === 'string' && raw.model.trim() && raw.model.length <= 200 ? raw.model.trim() : models[provider];
    const systemPrompt = typeof raw.systemPrompt === 'string' && raw.systemPrompt.length <= 8000 ? raw.systemPrompt : '';
    const key = typeof raw.key === 'string' && raw.key ? raw.key : undefined;
    config.profiles[provider] = { model, systemPrompt, key };
  }
  if (typeof value.tavilyKey === 'string' && value.tavilyKey) config.tavilyKey = value.tavilyKey;
  if (typeof value.ollamaHost === 'string' && value.ollamaHost.trim() && value.ollamaHost.length <= 500) {
    try {
      ollamaBaseUrl(value.ollamaHost);
      config.ollamaHost = value.ollamaHost.trim();
    } catch {
      // Ignore invalid host stored on disk and fall back to default/environment.
    }
  }
  return config;
}

async function loadUnlocked(): Promise<Config> {
  const file = settingsPath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw new Error('Could not read your settings file at ' + file + '. Check its permissions.', { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const config = parseConfig(parsed);
  if (config) return config;
  // Unreadable settings: keep a copy for recovery, record a UI warning, and start fresh instead of failing forever.
  const backup = file + '.corrupt-' + Date.now();
  await rename(file, backup).catch(() => {});
  resetNoticeForPath = file;
  console.warn('Research Buddy: settings file was invalid and has been reset. The previous file was moved to ' + backup);
  return defaults();
}

async function atomicWrite(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await rm(temp, { force: true }).catch(() => {});
  await writeFile(temp, content, { mode: 0o600 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 2 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

function keySource(provider: Provider, profile: Profile | undefined): KeySource {
  if (provider === 'ollama') return 'none';
  if (profile?.key) return 'saved';
  return envKey(provider) ? 'environment' : 'none';
}

function searchKeySource(config: Config): KeySource {
  if (config.tavilyKey) return 'saved';
  return envSearchKey() ? 'environment' : 'none';
}

function formatSettings(config: Config, requested?: Provider): Settings {
  const file = settingsPath();
  const provider = requested ?? config.provider;
  const profile = config.profiles[provider];
  const wasReset = resetNoticeForPath === file;
  return {
    provider,
    model: profile?.model ?? models[provider],
    // A blank prompt means "use the default", so the built-in safety guidance is never dropped by accident.
    systemPrompt: profile?.systemPrompt.trim() ? profile.systemPrompt : defaultPrompt,
    keySource: keySource(provider, profile),
    searchKeySource: searchKeySource(config),
    ollamaHost: config.ollamaHost ?? '',
    ...(wasReset ? { wasReset: true } : {}),
  };
}

export function getSettings(requested?: Provider): Promise<Settings> {
  return withLock(async () => formatSettings(await loadUnlocked(), requested));
}

export function saveSettings(input: SettingsUpdate): Promise<Settings> {
  return withLock(async () => {
    if (!isRecord(input)) throw new Error('Enter a valid provider, model, system prompt, and API key.');
    const {
      provider, model, systemPrompt, apiKey, clearKey,
      tavilyApiKey = '', clearTavilyKey = false, ollamaHost, dismissReset = false,
    } = input;
    if (!isProvider(provider) || typeof model !== 'string' || !model.trim() || model.length > 200 ||
        typeof systemPrompt !== 'string' || systemPrompt.length > 8000 ||
        typeof apiKey !== 'string' || apiKey.length > 2048 || typeof clearKey !== 'boolean' ||
        typeof tavilyApiKey !== 'string' || tavilyApiKey.length > 2048 || typeof clearTavilyKey !== 'boolean' ||
        (ollamaHost !== undefined && (typeof ollamaHost !== 'string' || ollamaHost.length > 500)) ||
        typeof dismissReset !== 'boolean') {
      throw new Error('Enter a valid provider, model, system prompt, and API key.');
    }
    const trimmedHost = ollamaHost?.trim();
    if (trimmedHost) ollamaBaseUrl(trimmedHost);

    const config = await loadUnlocked();
    let key = clearKey ? undefined : config.profiles[provider]?.key;
    if (apiKey.trim() && provider !== 'ollama') {
      if (!canEncrypt()) throw new Error('Unlock or configure your system keyring before saving an API key.');
      key = safeStorage.encryptString(apiKey.trim()).toString('base64');
    }

    let searchKey = clearTavilyKey ? undefined : config.tavilyKey;
    if (tavilyApiKey.trim()) {
      if (!/^[!-~]+$/.test(tavilyApiKey.trim())) throw new Error('Tavily API key contains invalid characters.');
      if (!canEncrypt()) throw new Error('Unlock or configure your system keyring before saving an API key.');
      searchKey = safeStorage.encryptString(tavilyApiKey.trim()).toString('base64');
    }

    config.provider = provider;
    config.profiles[provider] = { model: model.trim(), systemPrompt: systemPrompt.trim() === defaultPrompt ? '' : systemPrompt, key };
    if (searchKey) config.tavilyKey = searchKey;
    else delete config.tavilyKey;
    if (ollamaHost !== undefined) {
      if (trimmedHost) config.ollamaHost = trimmedHost;
      else delete config.ollamaHost;
    }

    const file = settingsPath();
    if (resetNoticeForPath === file || dismissReset) resetNoticeForPath = undefined;
    await atomicWrite(file, JSON.stringify(config, null, 2));
    return formatSettings(config);
  });
}

function decryptStoredKey(encrypted: string, label: string): string {
  try {
    if (!canEncrypt()) throw new Error();
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    throw new Error(`Could not unlock your saved ${label}. Check your system keyring or replace the key in Settings.`);
  }
}

export function getKey(provider: Provider): Promise<string> {
  return withLock(async () => {
    const key = (await loadUnlocked()).profiles[provider]?.key;
    if (!key) return envKey(provider);
    return decryptStoredKey(key, 'API key');
  });
}

export function getSearchKey(): Promise<string> {
  return withLock(async () => {
    const key = (await loadUnlocked()).tavilyKey;
    if (!key) return envSearchKey();
    return decryptStoredKey(key, 'Tavily API key');
  });
}
