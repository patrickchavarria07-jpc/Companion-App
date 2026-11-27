import type { Message, Settings } from '../shared/protocol';
import { createNdjsonParser, createSseParser } from './stream';

const endpoints = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};
export const defaultOllamaUrl = 'http://127.0.0.1:11434';
/** How long to wait for the first byte, and between later chunks, before giving up. */
export const defaultIdleTimeoutMs = 120_000;

type Format = 'gemini' | 'openai' | 'ollama';
type ErrorBody = { code?: number | string; message?: string; status?: string } | string;
type Packet = {
  error?: ErrorBody;
  message?: { content?: string } | string;
  choices?: { delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }[];
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  done?: boolean;
  done_reason?: string;
};

export type ProviderRequest = { format: Format; url: string; headers: Record<string, string>; body: unknown };
export type StreamOptions = { signal: AbortSignal; onText: (text: string) => void; idleTimeoutMs?: number };
export class ProviderTimeoutError extends Error {}

/** Resolves the Ollama base URL from an `OLLAMA_HOST`-style value, following Ollama's own defaults. */
export function ollamaBaseUrl(value?: string): string {
  const raw = value?.trim();
  if (!raw) return defaultOllamaUrl;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  try {
    const url = new URL(hasScheme ? raw : 'http://' + raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    // A server bound to all interfaces is reachable on loopback.
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
    if (url.hostname === '[::]') url.hostname = '[::1]';
    if (!hasScheme && !/^[^/]*:\d+(\/|$)/.test(raw.replace(/^\[[^\]]*\]/, 'h'))) url.port = '11434';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    throw new Error('OLLAMA_HOST is not a valid address. Use a value like 127.0.0.1:11434.');
  }
}

/**
 * Ollama silently truncates prompts that exceed its context window, which would drop attached
 * documents. Returns a `num_ctx` large enough for the request, or undefined if the default suffices.
 */
export function ollamaContextSize(characters: number): number | undefined {
  // Roughly 3 characters per token (conservative), plus room for the reply.
  const needed = Math.ceil(characters / 3) + 2048;
  if (needed <= 4096) return undefined;
  let size = 8192;
  while (size < needed && size < 65_536) size *= 2;
  return size;
}

export function buildRequest(
  settings: Pick<Settings, 'provider' | 'model' | 'systemPrompt'>, key: string, messages: Message[],
  env: Record<string, string | undefined> = process.env,
): ProviderRequest {
  const { provider, model, systemPrompt } = settings;
  if (provider !== 'ollama' && !key) throw new Error('Add an API key in Settings before sending a message.');
  const withSystem = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
  if (provider === 'gemini') {
    const modelId = model.replace(/^models\//, '');
    return {
      format: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelId) + ':streamGenerateContent?alt=sse',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-goog-api-key': key },
      body: {
        ...(modelId === 'gemini-3.5-flash' && {
          generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
        }),
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: messages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
      },
    };
  }
  if (provider === 'ollama') {
    const characters = [systemPrompt, ...messages.map(message => message.content)].reduce((total, text) => total + text.length, 0);
    const numCtx = ollamaContextSize(characters);
    return {
      format: 'ollama',
      url: ollamaBaseUrl(env.OLLAMA_HOST) + '/api/chat',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: { model, stream: true, messages: withSystem, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) },
    };
  }
  return {
    format: 'openai',
    url: endpoints[provider],
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + key },
    body: { model, stream: true, messages: withSystem },
  };
}

function cleanDetail(message: string, key: string): string {
  let text = message.replace(/\s+/g, ' ').trim();
  if (key.length >= 8) text = text.split(key).join('[redacted]');
  return text.length > 300 ? text.slice(0, 297) + '…' : text;
}

/** Maps a provider failure to a user-facing error, keeping the provider's own message as detail. */
export function providerError(code: number | string | undefined, message = '', key = ''): Error {
  const status = Number(code);
  const detail = cleanDetail(message, key);
  const error = (text: string) => new Error(detail ? text + '\nProvider message: ' + detail : text);
  if (status === 429) return error('Rate limit reached. Wait a moment or choose another model in Settings.');
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return error('The provider rejected access. Check your API key and model permissions in Settings.');
  }
  if (status === 402) return error('This model requires credits. Choose a free model in Settings.');
  if (status === 404) return error('Model unavailable. Check the model name and, for Ollama, pull it first.');
  if (status === 400 || status === 413) {
    return error('The provider rejected the request. Check the model name or shorten the conversation or attachments.');
  }
  return error('The provider returned an error' + (Number.isFinite(status) && status > 0 ? ' (HTTP ' + status + ')' : '') + '. Try again in a moment.');
}

const errorMessage = (error: ErrorBody | undefined) => typeof error === 'string' ? error : error?.message;
const errorCode = (error: ErrorBody | undefined) => typeof error === 'object' ? error.code : undefined;

function stopProblem(reason: string | undefined): 'truncated' | 'blocked' | undefined {
  const value = reason?.toLowerCase();
  if (value === 'length' || value === 'max_tokens') return 'truncated';
  if (value && ['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content', 'spii', 'image_safety'].includes(value)) {
    return 'blocked';
  }
  return undefined;
}

/** Interprets provider packets, forwards text, and decides whether the reply ended cleanly. */
class Reply {
  received = false;
  finished = false;
  stopReason: string | undefined;

  constructor(private readonly format: Format, private readonly onText: (text: string) => void, private readonly key: string) {}

  consume(payload: string) {
    if (payload.trim() === '[DONE]') {
      this.finished = true;
      return;
    }
    const packet = JSON.parse(payload) as Packet;
    if (packet.error) throw providerError(errorCode(packet.error), errorMessage(packet.error), this.key);
    let text: string | null | undefined;
    let reason: string | null | undefined;
    if (this.format === 'gemini') {
      const blocked = packet.promptFeedback?.blockReason;
      if (blocked) throw new Error('The provider blocked this request (' + blocked + '). Try rephrasing it.');
      const candidate = packet.candidates?.[0];
      text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('');
      reason = candidate?.finishReason;
    } else if (this.format === 'ollama') {
      text = typeof packet.message === 'object' ? packet.message.content : undefined;
      if (packet.done) reason = packet.done_reason || 'stop';
    } else {
      const choice = packet.choices?.[0];
      if (choice?.finish_reason === 'error') throw providerError(undefined, '', this.key);
      text = choice?.delta?.content ?? choice?.message?.content;
      reason = choice?.finish_reason;
    }
    if (reason) {
      this.finished = true;
      this.stopReason = reason;
    }
    if (text) {
      this.received = true;
      this.onText(text);
    }
  }

  end(streaming: boolean) {
    const problem = stopProblem(this.stopReason);
    if (!this.received) {
      if (problem === 'blocked') throw new Error('The provider blocked this reply (' + this.stopReason + '). Try rephrasing your request.');
      throw new Error('The model returned no text. Try rephrasing your request or choosing another model.');
    }
    if (problem === 'truncated') throw new Error('The reply reached the model\'s output limit and may be incomplete.');
    if (problem === 'blocked') throw new Error('The provider stopped this reply early (' + this.stopReason + '). The partial response is shown above.');
    if (streaming && !this.finished) throw new Error('The stream ended early. The partial response is shown above.');
  }
}

async function readErrorBody(response: Response, key: string): Promise<Error> {
  const text = await response.text().catch(() => '');
  let packet: Packet | undefined;
  try { packet = JSON.parse(text) as Packet; } catch { packet = undefined; }
  const message = errorMessage(packet?.error)
    || (typeof packet?.message === 'string' ? packet.message : '')
    || (!packet && !text.trimStart().startsWith('<') ? text : '');
  return providerError(response.status, message, key);
}

export async function streamReply(
  settings: Pick<Settings, 'provider' | 'model' | 'systemPrompt'>, key: string, messages: Message[], options: StreamOptions,
) {
  const { signal, onText, idleTimeoutMs = defaultIdleTimeoutMs } = options;
  const request = buildRequest(settings, key, messages);
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };
  const interruption = (): unknown => {
    if (signal.aborted) return signal.reason;
    if (idle.signal.aborted) return new ProviderTimeoutError('The model stopped responding. Try again.');
    return undefined;
  };
  touch();
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
        signal: AbortSignal.any([signal, idle.signal]), redirect: 'error',
      });
    } catch {
      throw interruption() ?? new Error(request.format === 'ollama'
        ? 'Could not connect to Ollama at ' + request.url.replace(/\/api\/chat$/, '') + '. Start Ollama and try again.'
        : 'Could not connect to the provider. Check your connection and try again.');
    }
    touch();
    if (!response.ok) throw await readErrorBody(response, key);
    if (!response.body) throw new Error('The provider returned an empty response.');

    const reply = new Reply(request.format, onText, key);
    const contentType = response.headers.get('content-type') ?? '';
    const mode = request.format === 'ollama' ? 'ndjson' : contentType.includes('text/event-stream') ? 'sse' : 'json';
    let whole = '';
    const parser = mode === 'sse' ? createSseParser(data => reply.consume(data))
      : mode === 'ndjson' ? createNdjsonParser(line => reply.consume(line))
        : { push: (text: string) => { whole += text; }, end: () => reply.consume(whole) };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        touch();
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
    } catch (error) {
      const interrupted = interruption();
      if (interrupted) throw interrupted;
      if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('The response was interrupted or unreadable. Try again.', { cause: error });
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
    reply.end(mode !== 'json');
  } finally {
    clearTimeout(timer);
  }
}
