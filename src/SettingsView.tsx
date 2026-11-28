import { useEffect, useState, type FormEvent } from 'react';
import { envKeyName, models, type KeySource, type Provider, type Settings } from '../shared/protocol';
import { api, errorText, providerNames } from './api';

type ProviderDraft = {
  model: string;
  systemPrompt: string;
  keySource: KeySource;
  apiKey: string;
  clearKey: boolean;
};

function toDraft(settings: Settings): ProviderDraft {
  return {
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    keySource: settings.keySource,
    apiKey: '',
    clearKey: false,
  };
}

export function SettingsView({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Settings;
  onSave: (settings: Settings) => void;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<Provider | undefined>(initial?.provider);
  const [drafts, setDrafts] = useState<Partial<Record<Provider, ProviderDraft>>>(() =>
    initial ? { [initial.provider]: toDraft(initial) } : {},
  );
  const [searchKeySource, setSearchKeySource] = useState<KeySource>(initial?.searchKeySource ?? 'none');
  const [tavilyKey, setTavilyKey] = useState('');
  const [clearTavilyKey, setClearTavilyKey] = useState(false);
  const [ollamaHost, setOllamaHost] = useState(initial?.ollamaHost ?? '');
  const [wasReset, setWasReset] = useState(Boolean(initial?.wasReset));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (provider) return;
    void api.settings().then(loaded => {
      setProvider(loaded.provider);
      setDrafts(current => ({ [loaded.provider]: toDraft(loaded), ...current }));
      setSearchKeySource(loaded.searchKeySource);
      setOllamaHost(loaded.ollamaHost);
      setWasReset(Boolean(loaded.wasReset));
    }).catch(err => setError(errorText(err)));
  }, [provider]);

  const active = provider ? drafts[provider] : undefined;

  function patchActive(patch: Partial<ProviderDraft>) {
    if (!provider || !active) return;
    setDrafts(current => ({ ...current, [provider]: { ...active, ...patch } }));
  }

  async function select(next: Provider) {
    setError('');
    if (drafts[next]) {
      setProvider(next);
      return;
    }
    setWorking(true);
    try {
      const loaded = await api.settings(next);
      setDrafts(current => ({ ...current, [next]: toDraft(loaded) }));
      setProvider(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!provider || !active || working) return;
    setWorking(true);
    setError('');
    try {
      const saved = await api.save({
        provider,
        model: active.model,
        systemPrompt: active.systemPrompt,
        apiKey: active.apiKey,
        clearKey: active.clearKey,
        tavilyApiKey: tavilyKey,
        clearTavilyKey,
        ollamaHost,
        dismissReset: true,
      });
      onSave(saved);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="settings" aria-label="Settings">
      <h2>Settings</h2>
      {wasReset && (
        <div className="error" role="alert">
          Your settings file was unreadable and was reset to defaults. Re-enter any saved API keys and save.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {provider && active && (
        <form onSubmit={event => void save(event)}>
          <fieldset disabled={working}>
            <label>Provider
              <select value={provider} onChange={event => void select(event.target.value as Provider)}>
                {Object.entries(providerNames).map(([value, name]) => (
                  <option key={value} value={value}>{name}</option>
                ))}
              </select>
            </label>
            <label>Model
              <input
                required
                maxLength={200}
                value={active.model}
                placeholder={models[provider]}
                onChange={event => patchActive({ model: event.target.value })}
              />
            </label>
            {provider !== 'ollama' ? (
              <>
                <label>API key
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={2048}
                    value={active.apiKey}
                    placeholder={active.keySource === 'saved'
                      ? 'Key saved · enter to replace'
                      : active.keySource === 'environment'
                        ? 'Using environment key · enter to override'
                        : 'Enter an API key'}
                    onChange={event => patchActive({ apiKey: event.target.value, clearKey: false })}
                  />
                </label>
                {active.keySource === 'saved' && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={active.clearKey}
                      onChange={event => patchActive({ clearKey: event.target.checked, apiKey: '' })}
                    /> Remove saved key
                  </label>
                )}
                {active.keySource === 'environment' && (
                  <p className="hint">
                    Using the key from the {envKeyName(provider)} environment variable. A key saved here takes precedence.
                  </p>
                )}
                <p className="hint">Chat and attached text are sent to the selected provider when you send a message.</p>
              </>
            ) : (
              <>
                <label>Ollama host
                  <input
                    maxLength={500}
                    value={ollamaHost}
                    placeholder="127.0.0.1:11434"
                    onChange={event => setOllamaHost(event.target.value)}
                  />
                </label>
                <p className="hint">
                  Leave blank to use OLLAMA_HOST or 127.0.0.1:11434.
                </p>
              </>
            )}
            <label>Web search API key (Tavily)
              <input
                type="password"
                autoComplete="off"
                maxLength={2048}
                value={tavilyKey}
                placeholder={searchKeySource === 'saved'
                  ? 'Key saved · enter to replace'
                  : searchKeySource === 'environment'
                    ? 'Using TAVILY_API_KEY · enter to override'
                    : 'Optional · enter to enable Web search'}
                onChange={event => { setTavilyKey(event.target.value); setClearTavilyKey(false); }}
              />
            </label>
            {searchKeySource === 'saved' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={clearTavilyKey}
                  onChange={event => { setClearTavilyKey(event.target.checked); setTavilyKey(''); }}
                /> Remove saved Tavily key
              </label>
            )}
            <label>System prompt
              <textarea
                rows={4}
                maxLength={8000}
                value={active.systemPrompt}
                placeholder="Leave blank to use the default prompt."
                onChange={event => patchActive({ systemPrompt: event.target.value })}
              />
            </label>
            <div className="settings-actions">
              <button className="primary">{working ? 'Working…' : 'Save settings'}</button>
              {onCancel && (
                <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
