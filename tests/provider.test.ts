import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRequest, ollamaBaseUrl, ollamaContextSize, providerError, ProviderTimeoutError, streamReply,
} from '../electron/provider';
import type { Message, Provider } from '../shared/protocol';

const messages: Message[] = [{ role: 'user', content: 'Hello' }];
const settings = (provider: Provider, systemPrompt = 'Be helpful') => ({ provider, model: 'test-model', systemPrompt });
const key = 'secret-key-123456';

function streamOf(chunks: string[], contentType = 'text/event-stream', status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function mockFetch(response: Response | ((init: RequestInit) => Response)) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => typeof response === 'function' ? response(init) : response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function run(provider: Provider, options: { signal?: AbortSignal; idleTimeoutMs?: number } = {}) {
  let text = '';
  try {
    await streamReply(settings(provider), key, messages, {
      signal: options.signal ?? new AbortController().signal,
      idleTimeoutMs: options.idleTimeoutMs,
      onText: chunk => { text += chunk; },
    });
    return { text };
  } catch (error) {
    return { text, error: error as Error };
  }
}

const openAiChunk = (content: string, finish: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] }) + '\n\n';

afterEach(() => { vi.unstubAllGlobals(); });

describe('buildRequest', () => {
  it('builds OpenAI-compatible requests for Groq and OpenRouter', () => {
    const request = buildRequest(settings('groq'), key, messages);
    expect(request.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer ' + key);
    expect(request.body).toEqual({
      model: 'test-model', stream: true,
      messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hello' }],
    });
    expect(buildRequest(settings('openrouter'), key, messages).url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('builds Gemini requests with the key in a header, not the URL', () => {
    const request = buildRequest({ ...settings('gemini'), model: 'models/gemini-x' }, key, [
      { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' },
    ]);
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    expect(request.url).not.toContain(key);
    expect(request.headers['x-goog-api-key']).toBe(key);
    expect(request.body).not.toHaveProperty('generationConfig');
    expect(request.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be helpful' }] },
      contents: [{ role: 'user' }, { role: 'model' }, { role: 'user' }],
    });
  });

  it.each(['gemini-3.5-flash', 'models/gemini-3.5-flash'])('requests low thinking for %s', model => {
    const request = buildRequest({ ...settings('gemini'), model }, key, messages);
    expect(request.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
    });
  });

  it('uses the native Ollama API and raises num_ctx for large requests', () => {
    const small = buildRequest(settings('ollama'), '', messages, {});
    expect(small.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(small.body).not.toHaveProperty('options');
    const large = buildRequest(settings('ollama'), '', [{ role: 'user', content: 'x'.repeat(60_000) }], { OLLAMA_HOST: 'gpu-box:9000' });
    expect(large.url).toBe('http://gpu-box:9000/api/chat');
    expect(large.body).toMatchObject({ options: { num_ctx: 32_768 } });
  });

  it('requires a key for hosted providers', () => {
    expect(() => buildRequest(settings('groq'), '', messages)).toThrow('Add an API key');
  });
});

describe('ollama helpers', () => {
  it.each([
    [undefined, 'http://127.0.0.1:11434'],
    ['', 'http://127.0.0.1:11434'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['localhost:8080', 'http://localhost:8080'],
    ['http://example.com', 'http://example.com'],
    ['https://example.com/ollama/', 'https://example.com/ollama'],
    ['[::1]:9000', 'http://[::1]:9000'],
  ])('resolves OLLAMA_HOST=%s', (value, expected) => {
    expect(ollamaBaseUrl(value)).toBe(expected);
  });

  it('rejects unusable OLLAMA_HOST values', () => {
    expect(() => ollamaBaseUrl('ftp://example.com')).toThrow('OLLAMA_HOST');
  });

  it('sizes the context window', () => {
    expect(ollamaContextSize(1_000)).toBeUndefined();
    expect(ollamaContextSize(10_000)).toBe(8_192);
    expect(ollamaContextSize(160_000)).toBe(65_536);
    expect(ollamaContextSize(1_000_000)).toBe(65_536);
  });
});

describe('providerError', () => {
  it('keeps the provider message as detail and redacts the key', () => {
    const error = providerError(400, 'Invalid model ' + key + '\n  given', key);
    expect(error.message).toBe('The provider rejected the request. Check the model name or shorten the conversation or attachments.\nProvider message: Invalid model [redacted] given');
  });

  it('maps common statuses', () => {
    expect(providerError(429).message).toMatch(/^Rate limit/);
    expect(providerError(401).message).toMatch(/rejected access/);
    expect(providerError(undefined, 'API key not valid').message).toMatch(/rejected access/);
    expect(providerError(402).message).toMatch(/credits/);
    expect(providerError(404).message).toMatch(/Model unavailable/);
    expect(providerError(503).message).toBe('The provider returned an error (HTTP 503). Try again in a moment.');
  });
});

describe('streamReply', () => {
  it('streams OpenAI-style SSE across arbitrary chunk boundaries', async () => {
    const payload = ': OPENROUTER PROCESSING\n\n' + openAiChunk('Hel') + openAiChunk('lo', 'stop') + 'data: [DONE]\n\n';
    const fetch = mockFetch(streamOf([payload.slice(0, 17), payload.slice(17, 60), payload.slice(60)]));
    expect(await run('openrouter')).toEqual({ text: 'Hello' });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('filters Gemini thought parts', async () => {
    const packet = { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Answer' }] }, finishReason: 'STOP' }] };
    mockFetch(streamOf(['data: ' + JSON.stringify(packet) + '\r\n\r\n']));
    expect(await run('gemini')).toEqual({ text: 'Answer' });
  });

  it('streams Ollama NDJSON', async () => {
    mockFetch(streamOf([
      '{"message":{"content":"Hi "}, "done": false}\n{"message":{"con',
      'tent":"there"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
    ], 'application/x-ndjson'));
    expect(await run('ollama')).toEqual({ text: 'Hi there' });
  });

  it('accepts a non-streaming JSON reply', async () => {
    mockFetch(streamOf([JSON.stringify({ choices: [{ message: { content: 'Whole reply' }, finish_reason: 'stop' }] })], 'application/json'));
    expect(await run('groq')).toEqual({ text: 'Whole reply' });
  });

  it('reports HTTP errors with provider details', async () => {
    mockFetch(streamOf([JSON.stringify({ error: { message: 'model `nope` does not exist' } })], 'application/json', 404));
    const { error } = await run('groq');
    expect(error?.message).toBe('Model unavailable. Check the model name and, for Ollama, pull it first.\nProvider message: model `nope` does not exist');
  });

  it('reads Ollama string errors', async () => {
    mockFetch(streamOf([JSON.stringify({ error: "model 'llama9' not found" })], 'application/json', 404));
    expect((await run('ollama')).error?.message).toContain("Provider message: model 'llama9' not found");
  });

  it('reports errors sent mid-stream and keeps partial text', async () => {
    mockFetch(streamOf([openAiChunk('Part'), 'data: ' + JSON.stringify({ error: { code: 429, message: 'slow down' } }) + '\n\n']));
    const result = await run('openrouter');
    expect(result.text).toBe('Part');
    expect(result.error?.message).toMatch(/^Rate limit reached/);
  });

  it('flags replies cut off by the output limit', async () => {
    mockFetch(streamOf([openAiChunk('Partial', 'length'), 'data: [DONE]\n\n']));
    expect((await run('groq')).error?.message).toMatch(/output limit/);
  });

  it('flags Gemini safety blocks', async () => {
    mockFetch(streamOf(['data: ' + JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) + '\n\n']));
    expect((await run('gemini')).error?.message).toBe('The provider blocked this request (SAFETY). Try rephrasing it.');
    mockFetch(streamOf(['data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Some' }] }, finishReason: 'SAFETY' }] }) + '\n\n']));
    expect(await run('gemini')).toMatchObject({ text: 'Some', error: { message: expect.stringMatching(/stopped this reply early \(SAFETY\)/) } });
  });

  it('detects streams that end early or contain no text', async () => {
    mockFetch(streamOf([openAiChunk('Half')]));
    expect((await run('groq')).error?.message).toMatch(/ended early/);
    mockFetch(streamOf(['data: [DONE]\n\n']));
    expect((await run('groq')).error?.message).toMatch(/returned no text/);
    mockFetch(streamOf(['data: {broken\n\n']));
    expect((await run('groq')).error?.message).toMatch(/interrupted or unreadable/);
  });

  it('reports connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await run('ollama')).error?.message).toBe('Could not connect to Ollama at http://127.0.0.1:11434. Start Ollama and try again.');
    expect((await run('groq')).error?.message).toMatch(/Could not connect to the provider/);
  });

  it('times out when the stream goes idle, keeping partial text', async () => {
    mockFetch(init => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openAiChunk('Started')));
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const result = await run('groq', { idleTimeoutMs: 50 });
    expect(result.text).toBe('Started');
    expect(result.error).toBeInstanceOf(ProviderTimeoutError);
    expect(result.error?.message).toBe('The model stopped responding. Try again.');
  });

  it('keeps streaming past the idle timeout while chunks keep arriving', async () => {
    mockFetch(() => {
      let count = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 20));
          controller.enqueue(new TextEncoder().encode(openAiChunk(String(count), count === 4 ? 'stop' : null)));
          if (++count === 5) controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    expect(await run('groq', { idleTimeoutMs: 60 })).toEqual({ text: '01234' });
  });

  it('rethrows the caller abort reason', async () => {
    const controller = new AbortController();
    mockFetch(init => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(openAiChunk('A')));
        init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason));
        setTimeout(() => controller.abort(new Error('stopped by user')), 10);
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const result = await run('groq', { signal: controller.signal });
    expect(result).toMatchObject({ text: 'A', error: { message: 'stopped by user' } });
  });
});
