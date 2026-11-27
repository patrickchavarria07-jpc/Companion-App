import { useEffect, useState, type FormEvent } from 'react';
import { envKeyName, models, type Provider, type Settings } from '../shared/protocol';
import { api, errorText, providerNames } from './api';

export function SettingsView({ initial, onSave }: { initial?: Settings; onSave: (settings: Settings) => void }) {
  const [form, setForm] = useState(initial);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!initial) void api.settings().then(setForm).catch(error => setError(errorText(error)));
  }, [initial]);

  async function select(provider: Provider) {
    setError('');
    setWorking(true);
    try {
      setForm(await api.settings(provider));
      setKey('');
      setClearKey(false);
    } catch (error) { setError(errorText(error)); }
    finally { setWorking(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || working) return;
    setWorking(true);
    setError('');
    try { onSave(await api.save({ ...form, apiKey: key, clearKey })); }
    catch (error) { setError(errorText(error)); }
    finally { setWorking(false); }
  }

  return <section className="settings">
    <h2>Settings</h2>
    {error && <div className="error" role="alert">{error}</div>}
    {form && <form onSubmit={save}>
      <fieldset disabled={working}>
        <label>Provider<select value={form.provider} onChange={event => void select(event.target.value as Provider)}>
          {Object.entries(providerNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select></label>
        <label>Model<input required maxLength={200} value={form.model} placeholder={models[form.provider]}
          onChange={event => setForm({ ...form, model: event.target.value })} /></label>
        {form.provider !== 'ollama' && <>
          <label>API key<input type="password" autoComplete="off" maxLength={2048} value={key}
            placeholder={form.keySource === 'saved' ? 'Key saved · enter to replace'
              : form.keySource === 'environment' ? 'Using environment key · enter to override' : 'Enter an API key'}
            onChange={event => { setKey(event.target.value); setClearKey(false); }} /></label>
          {form.keySource === 'saved' && <label className="check"><input type="checkbox" checked={clearKey} onChange={event => {
            setClearKey(event.target.checked);
            setKey('');
          }} /> Remove saved key</label>}
          {form.keySource === 'environment' && <p className="hint">Using the key from the {envKeyName(form.provider)} environment variable. A key saved here takes precedence.</p>}
        </>}
        <p className="hint">{form.provider === 'ollama'
          ? 'Uses Ollama at 127.0.0.1:11434 by default. Set the OLLAMA_HOST environment variable to use another address.'
          : 'Chat and attached text are sent to the selected provider when you send a message.'}</p>
        <label>System prompt<textarea rows={5} maxLength={8000} value={form.systemPrompt} placeholder="Leave blank to use the default prompt."
          onChange={event => setForm({ ...form, systemPrompt: event.target.value })} /></label>
        <button className="primary">{working ? 'Working…' : 'Save settings'}</button>
      </fieldset>
    </form>}
  </section>;
}
