import {
  useEffect, useRef, useState,
  type DragEvent, type PointerEvent, type UIEvent,
} from 'react';
import { flushSync } from 'react-dom';
import {
  fitConversation, supportedExtensions,
  type Attachment, type Message, type Settings, type WebSource,
} from '../shared/protocol';
import { api, errorText, providerNames } from './api';
import { Bot } from './Bot';
import { Markdown } from './Markdown';
import { SettingsView } from './SettingsView';

type ChatMessage = Message & { id: string; sources?: WebSource[] };
type ConfirmKind = 'quit' | 'clear' | null;

const busyDropMessage = 'Wait for the current task to finish before attaching files.';
const acceptTypes = supportedExtensions.join(',');

function formatMarkdownExport(messages: ChatMessage[]): string {
  const lines = ['# Research Buddy Conversation', ''];
  for (const message of messages) {
    lines.push(message.role === 'user' ? '## You' : '## Buddy', '', message.content);
    if (message.sources?.length) {
      lines.push('', '### Web sources');
      message.sources.forEach((source, idx) => lines.push(`${idx + 1}. [${source.title}](${source.url})`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [activeModel, setActiveModel] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [copiedId, setCopiedId] = useState('');
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);

  const pending = useRef(false);
  const attachCancelled = useRef(false);
  const frameRef = useRef<number | null>(null);
  const request = useRef<{ id: string; text: string; stopped: boolean } | null>(null);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const panelDrag = useRef(false);
  /** Whether new content should keep the conversation scrolled to the bottom. */
  const follow = useRef(true);
  const picker = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.settings().then(loaded => {
      setSettings(loaded);
      if (loaded.wasReset) {
        setError('Your settings file was unreadable and was reset to defaults. Open Settings to re-enter saved API keys.');
      }
    }).catch(err => setError(errorText(err)));

    const offChunk = api.onChunk(chunk => {
      if (request.current?.id !== chunk.id) return;
      request.current.text += chunk.text;
      if (!request.current.stopped) setStatus('Writing response…');
      if (typeof requestAnimationFrame === 'function') {
        if (frameRef.current === null) {
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            if (request.current) setAnswer(request.current.text);
          });
        }
      } else {
        setAnswer(request.current.text);
      }
    });

    const offOpen = api.onOpen?.(nextOpen => {
      if (nextOpen) {
        follow.current = true;
        setAtBottom(true);
      }
      setOpen(nextOpen);
    });

    return () => {
      if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current);
      }
      offChunk();
      offOpen?.();
    };
  }, []);

  // Follow new content only while the reader is at the bottom, so scrolling up to read isn't interrupted.
  useEffect(() => {
    if (!settingsOpen && follow.current) bottom.current?.scrollIntoView({ block: 'end' });
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
      if (value) {
        await api.expand(true);
        follow.current = true;
        setAtBottom(true);
        setOpen(true);
      } else {
        flushSync(() => setOpen(false));
        await api.expand(false);
      }
    } catch (err) {
      if (!value) setOpen(true);
      setError(errorText(err));
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (confirmKind) setConfirmKind(null);
      else if (settingsOpen) setSettingsOpen(false);
      else void expand(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, confirmKind, settingsOpen]);

  function stopActiveWork() {
    if (request.current) request.current.stopped = true;
    if (attaching) attachCancelled.current = true;
    api.cancel();
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
    attachCancelled.current = false;
    setBusy(true);
    setAttaching(true);
    setError('');
    await expand(true);
    setSettingsOpen(false);
    const errors: string[] = [];
    try {
      for (const file of selected) {
        if (attachCancelled.current) break;
        setStatus('Extracting text from ' + file.name + '…');
        try {
          const attached = await api.attach(file);
          setFiles(current => [...current, attached]);
        } catch (err) {
          const message = errorText(err);
          if (attachCancelled.current || message === 'Attachment cancelled.') break;
          errors.push(file.name + ' · ' + message);
        }
      }
      if (errors.length) setError(errors.join('\n'));
    } finally {
      const wasCancelled = attachCancelled.current;
      attachCancelled.current = false;
      pending.current = false;
      setAttaching(false);
      setBusy(false);
      setStatus(wasCancelled ? 'Attachment cancelled.' : '');
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    void attach(Array.from(event.dataTransfer.files));
  }

  async function send(text: string, search = false) {
    const trimmedText = text.trim();
    if (!trimmedText || pending.current) return;
    if (search && settings?.searchKeySource === 'none') {
      setError('Add a Tavily API key in Settings before using Web search.');
      return;
    }

    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: trimmedText };
    const conversation = [...messages, user];
    let fittedPayload: Message[];
    let clientTrimmed: number;
    try {
      const fitted = fitConversation(conversation);
      fittedPayload = fitted.messages.map(({ role, content }) => ({ role, content }));
      clientTrimmed = fitted.trimmed;
    } catch (err) {
      setError(errorText(err));
      return;
    }

    pending.current = true;
    const active = { id: crypto.randomUUID(), text: '', stopped: false };
    request.current = active;
    follow.current = true;
    setConfirmKind(null);
    setAtBottom(true);
    setMessages(conversation);
    setDraft('');
    setAnswer('');
    setError('');
    setActiveModel(settings ? providerNames[settings.provider] + ' · ' + settings.model : '');
    setStatus(search ? 'Searching the web and preparing a reply…' : 'Thinking…');
    setBusy(true);
    setSending(true);
    let failed = false;
    let sources: WebSource[] | undefined;
    let trimmedTurns = clientTrimmed;
    try {
      const result = await api.chat(active.id, fittedPayload, search);
      active.text = result.text;
      sources = result.sources;
      if (result.trimmed) trimmedTurns += result.trimmed;
      if (result.error) throw new Error(result.error);
    } catch (err) {
      failed = true;
      setError(errorText(err));
    } finally {
      if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (active.text) {
        setMessages([...conversation, { id: crypto.randomUUID(), role: 'assistant', content: active.text, sources }]);
      } else if (failed || active.stopped) {
        setMessages(messages);
        setDraft(user.content);
      }
      request.current = null;
      pending.current = false;
      setAnswer('');
      setActiveModel('');
      setSending(false);
      setBusy(false);
      setStatus(active.stopped
        ? 'Response stopped.'
        : trimmedTurns > 0
          ? `Older messages (${trimmedTurns}) were omitted to fit the context limit.`
          : '');
    }
  }

  async function remove(name: string) {
    try {
      await api.remove(name);
      setFiles(current => current.filter(file => file.name !== name));
    } catch (err) { setError(errorText(err)); }
  }

  function removeMessage(id: string) {
    if (busy) return;
    setMessages(current => current.filter(item => item.id !== id));
  }

  async function copyMessage(id: string, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(current => (current === id ? '' : current)), 1500);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  }

  function exportConversation() {
    if (!messages.length) return;
    const blob = new Blob([formatMarkdownExport(messages)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `research-buddy-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function requestQuit() {
    if (busy || messages.length > 0 || files.length > 0) setConfirmKind('quit');
    else api.quit();
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
  const modelSubtitle = sending && activeModel
    ? activeModel
    : settings
      ? providerNames[settings.provider] + ' · ' + settings.model
      : 'Desktop assistant';

  if (!open) return (
    <main className={'widget' + dropState} {...dragProps}>
      <button
        className="buddy-button"
        aria-label="Open Research Buddy"
        title={over && busy ? busyDropMessage : 'Click to open • Drag to move • Drop a PDF or text file'}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { x: event.screenX, y: event.screenY, moved: false };
          dragged.current = false;
          api.drag('start');
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onClick={event => { if (event.detail === 0 || !dragged.current) void expand(true); }}
      >
        <Bot />
      </button>
    </main>
  );

  return (
    <main className={'panel' + dropState} {...dragProps}>
      <header
        className="bar"
        title="Drag to move"
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as Element).closest('button')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          panelDrag.current = true;
          api.drag('start');
        }}
        onPointerMove={() => { if (panelDrag.current) api.drag('move'); }}
        onPointerUp={endPanelDrag}
        onPointerCancel={endPanelDrag}
        onLostPointerCapture={endPanelDrag}
      >
        <button className="bar-bot" aria-label="Collapse Research Buddy" title="Collapse Research Buddy" onClick={() => void expand(false)}><Bot /></button>
        <div className="identity"><h1>Research Buddy</h1><span>{modelSubtitle}</span></div>
        <button className="icon" title="Settings" aria-label="Settings" aria-pressed={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>⚙</button>
        <button className="icon" title="Collapse (Esc)" aria-label="Collapse" onClick={() => void expand(false)}>−</button>
        <button className="icon quit" title="Quit or hide" aria-label="Quit" onClick={requestQuit}>×</button>
      </header>

      {confirmKind === 'quit' && (
        <div className="confirm-bar" role="alert">
          <span>Quit Research Buddy and clear this session?</span>
          <div className="confirm-actions">
            <button type="button" className="secondary" onClick={() => { setConfirmKind(null); api.hide(); }}>Hide to tray</button>
            <button type="button" className="danger-btn" onClick={() => api.quit()}>Quit</button>
            <button type="button" className="reset" onClick={() => setConfirmKind(null)}>Cancel</button>
          </div>
        </div>
      )}

      {confirmKind === 'clear' && (
        <div className="confirm-bar" role="alert">
          <span>Clear all messages in this conversation?</span>
          <div className="confirm-actions">
            <button type="button" className="danger-btn" onClick={() => {
              setMessages([]);
              setError('');
              setStatus('');
              setConfirmKind(null);
            }}>Clear chat</button>
            <button type="button" className="reset" onClick={() => setConfirmKind(null)}>Cancel</button>
          </div>
        </div>
      )}

      {settingsOpen && (
        <>
          {busy && (
            <div className="active-banner" role="status">
              <span>{status || 'Working…'}</span>
              <button type="button" className="secondary" onClick={stopActiveWork}>
                {attaching ? 'Cancel' : 'Stop'}
              </button>
            </div>
          )}
          <SettingsView
            initial={settings}
            onCancel={() => setSettingsOpen(false)}
            onSave={value => {
              setSettings(value);
              setSettingsOpen(false);
              setError('');
            }}
          />
        </>
      )}

      <section className="conversation" aria-label="Conversation" onScroll={scrolled} hidden={settingsOpen}>
        {!messages.length && (
          <div className="welcome">
            <Bot />
            <h2>What are you exploring?</h2>
            <p>Ask a research question or drop a PDF, Markdown, CSV, or text file to discuss it here.</p>
            {files.length > 0 && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void send('Summarize the attached documents and highlight the main findings.')}
              >
                Summarize attachments
              </button>
            )}
          </div>
        )}
        {messages.map(message => (
          <article className={'message ' + message.role} key={message.id}>
            <div className="message-head">
              <strong>{message.role === 'user' ? 'You' : 'Buddy'}</strong>
              <div className="message-tools">
                {message.role === 'assistant' && (
                  <button
                    type="button"
                    className="msg-action"
                    aria-label="Copy reply"
                    onClick={() => void copyMessage(message.id, message.content)}
                  >
                    {copiedId === message.id ? 'Copied' : 'Copy'}
                  </button>
                )}
                <button
                  type="button"
                  className="msg-action"
                  disabled={busy}
                  aria-label="Delete message"
                  title="Remove message"
                  onClick={() => removeMessage(message.id)}
                >
                  ×
                </button>
              </div>
            </div>
            {message.role === 'assistant'
              ? <Markdown text={message.content} sources={message.sources} />
              : <div className="plain">{message.content}</div>}
            {!!message.sources?.length && (
              <div className="markdown web-sources">
                <strong>Web sources</strong>
                <ol>
                  {message.sources.map(source => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}>
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </article>
        ))}
        {answer && (
          <article className="message assistant">
            <strong>Buddy</strong>
            <Markdown text={answer} />
          </article>
        )}
        <div ref={bottom} />
      </section>

      <footer hidden={settingsOpen}>
        {!atBottom && (answer || messages.length > 0) && (
          <button type="button" className="jump" onClick={jumpToLatest}>↓ Latest</button>
        )}
        {!!files.length && (
          <div className="attachments" aria-label="Attached documents">
            {files.map(file => (
              <div className="attachment" key={file.name}>
                <span
                  title={file.characters.toLocaleString() + ' characters' + (file.excerpted ? ' · relevant excerpts selected per question' : '')}
                >
                  {file.name}{file.excerpted ? ' (excerpts)' : ''}
                </span>
                <button disabled={busy} aria-label={'Remove ' + file.name} onClick={() => void remove(file.name)}>×</button>
              </div>
            ))}
          </div>
        )}
        {error && <div role="alert" className="error">{error}</div>}
        <div className="status" role="status">{over ? (busy ? busyDropMessage : 'Drop to attach') : status}</div>
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(draft); }}>
          <input
            type="file"
            hidden
            ref={picker}
            multiple
            accept={acceptTypes}
            onChange={event => {
              void attach(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="icon"
            disabled={busy}
            title="Attach PDF or text file"
            aria-label="Attach PDF or text file"
            onClick={() => picker.current?.click()}
          >
            ＋
          </button>
          <textarea
            aria-label="Your message"
            rows={2}
            placeholder="Ask a question…"
            value={draft}
            readOnly={sending}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {sending || attaching ? (
            <button type="button" className="primary" onClick={stopActiveWork}>
              {attaching ? 'Cancel' : 'Stop'}
            </button>
          ) : (
            <button className="primary" disabled={busy || !draft.trim()}>Send</button>
          )}
        </form>
        <div className="chat-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || !draft.trim()}
            title={settings?.searchKeySource === 'none'
              ? 'Add a Tavily API key in Settings to use Web search'
              : draft.trim().length > 400
                ? 'Long questions are condensed to a 400-character search query'
                : 'Search the web with Tavily'}
            aria-describedby="web-search-provider"
            onClick={() => void send(draft, true)}
          >
            Web search
          </button>
          <span className="search-provider" id="web-search-provider">
            {settings?.searchKeySource === 'none' ? 'Add Tavily key in Settings' : 'Powered by Tavily'}
          </span>
          <div className="spacer" />
          {!!messages.length && (
            <>
              <button type="button" className="reset" disabled={busy} onClick={exportConversation}>Export</button>
              <button type="button" className="reset" disabled={busy} onClick={() => setConfirmKind('clear')}>New chat</button>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}
