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

const { getKey, getSearchKey, getSettings, parseConfig, saveSettings } = await import('../electron/settings');
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
    expect(await getSettings()).toEqual({
      provider: 'gemini',
      model: models.gemini,
      systemPrompt: defaultPrompt,
      keySource: 'none',
      searchKeySource: 'none',
      ollamaHost: '',
    });
  });

  it('saves settings, provider key, Tavily key, and Ollama host, then reads them back', async () => {
    const saved = await saveSettings({
      ...update,
      model: ' llama-3 ',
      systemPrompt: 'Custom',
      apiKey: ' gsk_123 ',
      tavilyApiKey: ' tvly-abc ',
      ollamaHost: ' gpu-box:11434 ',
    });
    expect(saved).toEqual({
      provider: 'groq',
      model: 'llama-3',
      systemPrompt: 'Custom',
      keySource: 'saved',
      searchKeySource: 'saved',
      ollamaHost: 'gpu-box:11434',
    });
    const stored = JSON.parse(await readFile(file(), 'utf8'));
    expect(stored.profiles.groq.key).toBe(Buffer.from('enc:gsk_123').toString('base64'));
    expect(stored.tavilyKey).toBe(Buffer.from('enc:tvly-abc').toString('base64'));
    expect(await getKey('groq')).toBe('gsk_123');
    expect(await getSearchKey()).toBe('tvly-abc');

    const cleared = await saveSettings({ ...update, clearTavilyKey: true, ollamaHost: '' });
    expect(cleared.searchKeySource).toBe('none');
    expect(cleared.ollamaHost).toBe('');
    expect(await getSearchKey()).toBe('');
  });

  it('keeps the saved key unless it is replaced or cleared', async () => {
    await saveSettings({ ...update, apiKey: 'first' });
    await saveSettings({ ...update, model: 'other' });
    expect(await getKey('groq')).toBe('first');
    expect((await saveSettings({ ...update, clearKey: true })).keySource).toBe('none');
    expect(await getKey('groq')).toBe('');
  });

  it('refuses to save keys without secure storage', async () => {
    state.encryption = false;
    await expect(saveSettings({ ...update, apiKey: 'k' })).rejects.toThrow('keyring');
    await expect(saveSettings({ ...update, tavilyApiKey: 'tvly-k' })).rejects.toThrow('keyring');
  });

  it('reports environment keys separately from saved keys for both chat and search', async () => {
    vi.stubEnv('GROQ_API_KEY', ' env-key ');
    vi.stubEnv('TAVILY_API_KEY', ' env-tvly ');
    const initial = await getSettings('groq');
    expect(initial.keySource).toBe('environment');
    expect(initial.searchKeySource).toBe('environment');
    expect(await getKey('groq')).toBe('env-key');
    expect(await getSearchKey()).toBe('env-tvly');

    await saveSettings({ ...update, apiKey: 'saved-key', tavilyApiKey: 'saved-tvly' });
    const overridden = await getSettings('groq');
    expect(overridden.keySource).toBe('saved');
    expect(overridden.searchKeySource).toBe('saved');
    expect(await getKey('groq')).toBe('saved-key');
    expect(await getSearchKey()).toBe('saved-tvly');
    expect((await getSettings('ollama')).keySource).toBe('none');
  });

  it('treats a blank system prompt as the default prompt', async () => {
    expect((await saveSettings({ ...update, systemPrompt: '   ' })).systemPrompt).toBe(defaultPrompt);
  });

  it('rejects invalid updates including malformed ollamaHost or Tavily keys', async () => {
    await expect(saveSettings({ ...update, provider: 'evil' as 'groq' })).rejects.toThrow('Enter a valid');
    await expect(saveSettings({ ...update, model: ' ' })).rejects.toThrow('Enter a valid');
    await expect(saveSettings({ ...update, clearKey: 'yes' as unknown as boolean })).rejects.toThrow('Enter a valid');
    await expect(saveSettings({ ...update, ollamaHost: 'ftp://bad-host' })).rejects.toThrow('OLLAMA_HOST');
    await expect(saveSettings({ ...update, tavilyApiKey: 'bad key with spaces' })).rejects.toThrow('Tavily API key');
    await expect(saveSettings(null as never)).rejects.toThrow('Enter a valid');
  });

  it('recovers from a corrupt settings file, keeps a backup, and surfaces wasReset until saved', async () => {
    await writeFile(file(), '{ not json');
    const reset = await getSettings();
    expect(reset.provider).toBe('gemini');
    expect(reset.wasReset).toBe(true);
    const files = await readdir(state.dir);
    expect(files.some(name => name.startsWith('settings.json.corrupt-'))).toBe(true);

    const saved = await saveSettings(update);
    expect(saved.provider).toBe('groq');
    expect(saved.wasReset).toBeUndefined();
  });

  it('serializes concurrent reads and writes without corrupting state', async () => {
    const results = await Promise.all([
      saveSettings({ ...update, model: 'm1', apiKey: 'k1' }),
      getSettings('groq'),
      saveSettings({ ...update, model: 'm2' }),
      getKey('groq'),
    ]);
    expect(results[2].model).toBe('m2');
    expect(await getKey('groq')).toBe('k1');
  });

  it('normalizes invalid fields instead of failing', async () => {
    await writeFile(file(), JSON.stringify({
      provider: 'unknown',
      ollamaHost: 'ftp://invalid',
      profiles: { groq: { model: 7, systemPrompt: null, key: 'abc' }, bogus: {} },
    }));
    expect(await getSettings()).toMatchObject({ provider: 'gemini', model: models.gemini, ollamaHost: '' });
    expect(await getSettings('groq')).toMatchObject({
      provider: 'groq', model: models.groq, systemPrompt: defaultPrompt, keySource: 'saved',
    });
  });
});

describe('parseConfig', () => {
  it('returns undefined for non-objects and fills missing profiles', () => {
    expect(parseConfig(null)).toBeUndefined();
    expect(parseConfig([])).toBeUndefined();
    expect(parseConfig({})).toEqual({ provider: 'gemini', profiles: {} });
  });
});
