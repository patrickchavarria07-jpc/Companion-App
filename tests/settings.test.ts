import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPrompt, models } from '../shared/protocol';

const state = vi.hoisted(() => ({ dir: '', encryption: true }));

vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.encryption,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from('enc:' + value),
    decryptString: (value: Buffer) => value.toString().slice(4),
  },
}));

const { getKey, getSettings, parseConfig, saveSettings } = await import('../electron/settings');
const file = () => join(state.dir, 'settings.json');
const update = { provider: 'groq' as const, model: 'm', systemPrompt: '', apiKey: '', clearKey: false };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), 'buddy-settings-'));
  state.encryption = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(state.dir, { recursive: true, force: true });
});

describe('settings', () => {
  it('returns defaults when no settings file exists', async () => {
    expect(await getSettings()).toEqual({ provider: 'gemini', model: models.gemini, systemPrompt: defaultPrompt, keySource: 'none' });
  });

  it('saves settings and an encrypted key, then reads them back', async () => {
    const saved = await saveSettings({ ...update, model: ' llama-3 ', systemPrompt: 'Custom', apiKey: ' gsk_123 ' });
    expect(saved).toEqual({ provider: 'groq', model: 'llama-3', systemPrompt: 'Custom', keySource: 'saved' });
    const stored = JSON.parse(await readFile(file(), 'utf8'));
    expect(stored.profiles.groq.key).toBe(Buffer.from('enc:gsk_123').toString('base64'));
    expect(await getKey('groq')).toBe('gsk_123');
  });

  it('keeps the saved key unless it is replaced or cleared', async () => {
    await saveSettings({ ...update, apiKey: 'first' });
    await saveSettings({ ...update, model: 'other' });
    expect(await getKey('groq')).toBe('first');
    expect((await saveSettings({ ...update, clearKey: true })).keySource).toBe('none');
    expect(await getKey('groq')).toBe('');
  });

  it('refuses to save a key without secure storage', async () => {
    state.encryption = false;
    await expect(saveSettings({ ...update, apiKey: 'k' })).rejects.toThrow('keyring');
  });

  it('reports environment keys separately from saved keys', async () => {
    vi.stubEnv('GROQ_API_KEY', ' env-key ');
    expect((await getSettings('groq')).keySource).toBe('environment');
    expect(await getKey('groq')).toBe('env-key');
    await saveSettings({ ...update, apiKey: 'saved-key' });
    expect((await getSettings('groq')).keySource).toBe('saved');
    expect(await getKey('groq')).toBe('saved-key');
    expect((await getSettings('ollama')).keySource).toBe('none');
  });

  it('treats a blank system prompt as the default prompt', async () => {
    expect((await saveSettings({ ...update, systemPrompt: '   ' })).systemPrompt).toBe(defaultPrompt);
  });

  it('rejects invalid updates', async () => {
    await expect(saveSettings({ ...update, provider: 'evil' as 'groq' })).rejects.toThrow('Enter a valid');
    await expect(saveSettings({ ...update, model: ' ' })).rejects.toThrow('Enter a valid');
    await expect(saveSettings({ ...update, clearKey: 'yes' as unknown as boolean })).rejects.toThrow('Enter a valid');
    await expect(saveSettings(null as never)).rejects.toThrow('Enter a valid');
  });

  it('recovers from a corrupt settings file and keeps a backup', async () => {
    await writeFile(file(), '{ not json');
    expect((await getSettings()).provider).toBe('gemini');
    const files = await readdir(state.dir);
    expect(files.some(name => name.startsWith('settings.json.corrupt-'))).toBe(true);
    expect((await saveSettings(update)).provider).toBe('groq');
  });

  it('normalizes invalid fields instead of failing', async () => {
    await writeFile(file(), JSON.stringify({ provider: 'unknown', profiles: { groq: { model: 7, systemPrompt: null, key: 'abc' }, bogus: {} } }));
    expect(await getSettings()).toMatchObject({ provider: 'gemini', model: models.gemini });
    expect(await getSettings('groq')).toEqual({ provider: 'groq', model: models.groq, systemPrompt: defaultPrompt, keySource: 'saved' });
  });
});

describe('parseConfig', () => {
  it('returns undefined for non-objects and fills missing profiles', () => {
    expect(parseConfig(null)).toBeUndefined();
    expect(parseConfig([])).toBeUndefined();
    expect(parseConfig({})).toEqual({ provider: 'gemini', profiles: {} });
  });
});
