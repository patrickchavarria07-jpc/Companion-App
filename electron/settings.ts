import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPrompt, models, type Provider, type Settings, type SettingsUpdate } from '../shared/protocol';

type Profile = { model: string; systemPrompt: string; key?: string };
type Config = { provider: Provider; profiles: Partial<Record<Provider, Profile>> };
const path = () => join(app.getPath('userData'), 'settings.json');
const canEncrypt = () => safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
const envKey = (provider: Provider) => provider === 'ollama' ? '' : process.env[provider.toUpperCase() + '_API_KEY']?.trim() || '';

async function load(): Promise<Config> {
  try {
    return JSON.parse(await readFile(path(), 'utf8')) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read your local settings.');
    }
    return { provider: 'gemini', profiles: {} };
  }
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && Object.hasOwn(models, value);
}

export async function getSettings(requested?: Provider): Promise<Settings> {
  const { provider: selected, profiles } = await load();
  const provider = requested ?? selected;
  const profile = profiles[provider];
  return {
    provider,
    model: profile?.model ?? models[provider],
    systemPrompt: profile?.systemPrompt ?? defaultPrompt,
    hasKey: Boolean(profile?.key || envKey(provider)),
  };
}

export async function saveSettings(input: SettingsUpdate): Promise<Settings> {
  const { provider, model, systemPrompt, apiKey, clearKey } = input;
  if (!isProvider(provider) || typeof model !== 'string' || !model.trim() || model.length > 200 ||
      typeof systemPrompt !== 'string' || systemPrompt.length > 8000 ||
      typeof apiKey !== 'string' || apiKey.length > 2048) {
    throw new Error('Enter a valid provider, model, system prompt, and API key.');
  }
  const config = await load();
  let key = clearKey ? undefined : config.profiles[provider]?.key;
  if (apiKey.trim() && provider !== 'ollama') {
    if (!canEncrypt()) throw new Error('Unlock or configure your system keyring before saving an API key.');
    key = safeStorage.encryptString(apiKey.trim()).toString('base64');
  }
  config.provider = provider;
  config.profiles[provider] = { model: model.trim(), systemPrompt, key };
  const temp = path() + '.tmp';
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temp, path());
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
