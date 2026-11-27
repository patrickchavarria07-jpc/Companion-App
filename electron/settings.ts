import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultPrompt, envKeyName, models, providers, type KeySource, type Provider, type Settings, type SettingsUpdate,
} from '../shared/protocol';
import { isRecord } from './validation';

type Profile = { model: string; systemPrompt: string; key?: string };
type Config = { provider: Provider; profiles: Partial<Record<Provider, Profile>> };

export const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const defaults = (): Config => ({ provider: 'gemini', profiles: {} });
const canEncrypt = () => safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
const envKey = (provider: Provider) => provider === 'ollama' ? '' : process.env[envKeyName(provider)]?.trim() || '';

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
  return config;
}

async function load(): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw new Error('Could not read your settings file at ' + settingsPath() + '. Check its permissions.', { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  const config = parseConfig(parsed);
  if (config) return config;
  // Unreadable settings: keep a copy for recovery and start fresh instead of failing forever.
  const backup = settingsPath() + '.corrupt-' + Date.now();
  await rename(settingsPath(), backup).catch(() => {});
  console.warn('Research Buddy: settings file was invalid and has been reset. The previous file was moved to ' + backup);
  return defaults();
}

function keySource(provider: Provider, profile: Profile | undefined): KeySource {
  if (provider === 'ollama') return 'none';
  if (profile?.key) return 'saved';
  return envKey(provider) ? 'environment' : 'none';
}

export async function getSettings(requested?: Provider): Promise<Settings> {
  const { provider: selected, profiles } = await load();
  const provider = requested ?? selected;
  const profile = profiles[provider];
  return {
    provider,
    model: profile?.model ?? models[provider],
    // A blank prompt means "use the default", so the built-in safety guidance is never dropped by accident.
    systemPrompt: profile?.systemPrompt.trim() ? profile.systemPrompt : defaultPrompt,
    keySource: keySource(provider, profile),
  };
}

export async function saveSettings(input: SettingsUpdate): Promise<Settings> {
  if (!isRecord(input)) throw new Error('Enter a valid provider, model, system prompt, and API key.');
  const { provider, model, systemPrompt, apiKey, clearKey } = input;
  if (!isProvider(provider) || typeof model !== 'string' || !model.trim() || model.length > 200 ||
      typeof systemPrompt !== 'string' || systemPrompt.length > 8000 ||
      typeof apiKey !== 'string' || apiKey.length > 2048 || typeof clearKey !== 'boolean') {
    throw new Error('Enter a valid provider, model, system prompt, and API key.');
  }
  const config = await load();
  let key = clearKey ? undefined : config.profiles[provider]?.key;
  if (apiKey.trim() && provider !== 'ollama') {
    if (!canEncrypt()) throw new Error('Unlock or configure your system keyring before saving an API key.');
    key = safeStorage.encryptString(apiKey.trim()).toString('base64');
  }
  config.provider = provider;
  config.profiles[provider] = { model: model.trim(), systemPrompt: systemPrompt.trim() === defaultPrompt ? '' : systemPrompt, key };
  const temp = settingsPath() + '.tmp';
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temp, settingsPath());
  return getSettings();
}

export async function getKey(provider: Provider): Promise<string> {
  const key = (await load()).profiles[provider]?.key;
  if (!key) return envKey(provider);
  try {
    if (!canEncrypt()) throw new Error();
    return safeStorage.decryptString(Buffer.from(key, 'base64'));
  } catch {
    throw new Error('Could not unlock your saved API key. Check your system keyring or replace the key in Settings.');
  }
}
