import { useEffect, useRef, useState, type DragEvent, type PointerEvent, type UIEvent } from 'react';
import type { Attachment, Message, Settings } from '../shared/protocol';
import { api, errorText, providerNames } from './api';
import { Bot } from './Bot';
import { Markdown } from './Markdown';
import { SettingsView } from './SettingsView';

const busyDropMessage = 'Wait for the current task to finish before attaching files.';

export default function App() {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [files, setFiles] = useState<Attachment[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const pending = useRef(false);
  const request = useRef<{ id: string; text: string; stopped: boolean } | null>(null);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const panelDrag = useRef(false);
  /** Whether new content should keep the conversation scrolled to the bottom. */
  const follow = useRef(true);
  const picker = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.settings().then(setSettings).catch(error => setError(errorText(error)));
    return api.onChunk(chunk => {
      if (request.current?.id !== chunk.id) return;
      request.current.text += chunk.text;
      setAnswer(request.current.text);
      if (!request.current.stopped) setStatus('Writing response…');
    });
  }, []);
  // Follow new content only while the reader is at the bottom, so scrolling up to read isn't interrupted.
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [answer, messages, open, settingsOpen]);

  function jumpToLatest() {
    follow.current = true;
    setAtBottom(true);
    bottom.current?.scrollIntoView({ block: 'end' });
  }

  function scrolled(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    follow.current = near;
    setAtBottom(near);
  }

  async function expand(value: boolean) {
    try {
      await api.expand(value);
      if (value) jumpToLatest();
      setOpen(value);
    } catch (error) { setError(errorText(error)); }
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = pointer.current;
    if (!start) return;
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) >= 5) start.moved = true;
    if (start.moved) api.drag('move');
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    if (!pointer.current) return;
    dragged.current = pointer.current.moved || event.type === 'pointercancel';
    pointer.current = null;
    api.drag('end');
  }

  function endPanelDrag() {
    if (!panelDrag.current) return;
    panelDrag.current = false;
    api.drag('end');
  }

  async function attach(selected: File[]) {
    if (!selected.length) return;
    if (pending.current) {
      setError(busyDropMessage);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    await expand(true);
    setSettingsOpen(false);
    const errors: string[] = [];
    try {
      for (const file of selected) {
        setStatus('Extracting text from ' + file.name + '…');
        try {
          const attached = await api.attach(file);
          setFiles(current => [...current, attached]);
        } catch (error) { errors.push(file.name + ' · ' + errorText(error)); }
      }
      if (errors.length) setError(errors.join('\n'));
    } finally {
      pending.current = false;
      setBusy(false);
      setStatus('');
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    void attach(Array.from(event.dataTransfer.files));
  }

  async function send(text: string) {
    if (!text.trim() || pending.current) return;
    pending.current = true;
    const user: Message = { role: 'user', content: text.trim() };
    const conversation = [...messages, user];
    const active = { id: crypto.randomUUID(), text: '', stopped: false };
    request.current = active;
    follow.current = true;
    setAtBottom(true);
    setMessages(conversation);
    setDraft('');
    setAnswer('');
    setError('');
    setStatus('Thinking…');
    setBusy(true);
    setSending(true);
    let failed = false;
    try {
      const result = await api.chat(active.id, conversation);
      active.text = result.text;
      if (result.error) throw new Error(result.error);
    } catch (error) {
      failed = true;
      setError(errorText(error));
    } finally {
      if (active.text) setMessages([...conversation, { role: 'assistant', content: active.text }]);
      else if (failed || active.stopped) {
        setMessages(messages);
        setDraft(user.content);
      }
      request.current = null;
      pending.current = false;
      setAnswer('');
      setSending(false);
      setBusy(false);
      setStatus(active.stopped ? 'Response stopped.' : '');
    }
  }

  async function remove(name: string) {
    try {
      await api.remove(name);
      setFiles(current => current.filter(file => file.name !== name));
    } catch (error) { setError(errorText(error)); }
  }

  const dragProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer.types.includes('Files')) {
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
        setOver(true);
      }
    },
    onDragLeave: (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false);
    },
    onDrop: drop,
  };
  const dropState = over ? (busy ? ' blocked' : ' over') : '';

  if (!open) return (
    <main className={'widget' + dropState} {...dragProps}>
      <button className="buddy-button" aria-label="Open Research Buddy"
        title={over && busy ? busyDropMessage : 'Click to open • Drag to move • Drop a PDF or TXT'}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { x: event.screenX, y: event.screenY, moved: false };
          dragged.current = false;
          api.drag('start');
        }}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onClick={event => { if (event.detail === 0 || !dragged.current) void expand(true); }}>
        <Bot />
      </button>
    </main>
  );

  return (
    <main className={'panel' + dropState} {...dragProps}>
      <header className="bar" title="Drag to move"
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as Element).closest('button')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          panelDrag.current = true;
          api.drag('start');
        }}
        onPointerMove={() => { if (panelDrag.current) api.drag('move'); }}
        onPointerUp={endPanelDrag} onPointerCancel={endPanelDrag} onLostPointerCapture={endPanelDrag}>
        <button className="bar-bot" aria-label="Collapse Research Buddy" title="Collapse Research Buddy" onClick={() => void expand(false)}><Bot /></button>
        <div className="identity"><h1>Research Buddy</h1><span>{settings ? providerNames[settings.provider] + ' · ' + settings.model : 'Desktop assistant'}</span></div>
        <button className="icon" title="Settings" aria-label="Settings" aria-pressed={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>⚙</button>
        <button className="icon" title="Collapse" aria-label="Collapse" onClick={() => void expand(false)}>−</button>
        <button className="icon quit" title="Quit" aria-label="Quit" onClick={() => api.quit()}>×</button>
      </header>
      {settingsOpen ? <SettingsView initial={settings} onSave={value => { setSettings(value); setSettingsOpen(false); setError(''); }} />
        : <>
          <section className="conversation" aria-label="Conversation" onScroll={scrolled}>
            {!messages.length && <div className="welcome">
              <Bot />
              <h2>What are you exploring?</h2>
              <p>Ask a research question or drop a PDF or TXT file to discuss it here.</p>
              {files.length > 0 && <button className="secondary" disabled={busy} onClick={() => void send('Summarize the attached documents and highlight the main findings.')}>Summarize attachments</button>}
            </div>}
            {messages.map((message, index) => <article className={'message ' + message.role} key={index}>
              <strong>{message.role === 'user' ? 'You' : 'Buddy'}</strong>
              {message.role === 'assistant' ? <Markdown text={message.content} /> : <div className="plain">{message.content}</div>}
            </article>)}
            {answer && <article className="message assistant"><strong>Buddy</strong><Markdown text={answer} /></article>}
            <div ref={bottom} />
          </section>
          <footer>
            {!atBottom && (answer || messages.length > 0) &&
              <button type="button" className="jump" onClick={jumpToLatest}>↓ Latest</button>}
            {!!files.length && <div className="attachments" aria-label="Attached documents">
              {files.map(file => <div className="attachment" key={file.name}>
                <span title={file.characters.toLocaleString() + ' characters'}>{file.name}</span>
                <button disabled={busy} aria-label={'Remove ' + file.name} onClick={() => void remove(file.name)}>×</button>
              </div>)}
            </div>}
            {error && <div role="alert" className="error">{error}</div>}
            <div className="status" role="status">{over ? (busy ? busyDropMessage : 'Drop to attach') : status}</div>
            <form className="composer" onSubmit={event => { event.preventDefault(); void send(draft); }}>
              <input type="file" hidden ref={picker} multiple accept=".txt,.pdf" onChange={event => {
                void attach(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = '';
              }} />
              <button type="button" className="icon" disabled={busy} title="Attach PDF or TXT" aria-label="Attach PDF or TXT" onClick={() => picker.current?.click()}>＋</button>
              <textarea aria-label="Your message" rows={2} placeholder="Ask a question…" value={draft} readOnly={sending} onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send(draft);
                  }
                }} />
              {sending ? <button type="button" className="primary" onClick={() => {
                if (request.current) request.current.stopped = true;
                api.cancel();
              }}>Stop</button> : <button className="primary" disabled={busy || !draft.trim()}>Send</button>}
            </form>
            {!!messages.length && <button className="reset" disabled={busy} onClick={() => { setMessages([]); setError(''); setStatus(''); }}>New chat</button>}
          </footer>
        </>}
    </main>
  );
}
