import type { Message, Settings } from '../shared/protocol';

const endpoints = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  ollama: 'http://127.0.0.1:11434/v1/chat/completions',
};

type Packet = {
  error?: { code?: number | string; message?: string };
  choices?: { delta?: { content?: string }; finish_reason?: string }[];
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
};

function providerError(code: number | string | undefined, message = ''): Error {
  if (Number(code) === 429) return new Error('Rate limit reached. Wait a moment or choose another model in Settings.');
  if ([401, 403].includes(Number(code)) || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return new Error('The provider rejected access. Check your API key and model permissions in Settings.');
  }
  if (Number(code) === 402) return new Error('This model requires credits. Choose a free model in Settings.');
  if (Number(code) === 404) return new Error('Model unavailable. Check the model name and, for Ollama, pull it first.');
  if (Number(code) === 400 || Number(code) === 413) return new Error('The provider rejected the request. Check the model name or shorten the conversation or attachments.');
  return new Error('The provider returned an error. Try again in a moment.');
}

export async function streamReply(
  settings: Settings, key: string, messages: Message[], signal: AbortSignal, onText: (text: string) => void,
) {
  const { provider, model, systemPrompt } = settings;
  if (provider !== 'ollama' && !key) throw new Error('Add an API key in Settings before sending a message.');
  const gemini = provider === 'gemini';
  const url = gemini
    ? 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model.replace(/^models\//, '')) + ':streamGenerateContent?alt=sse'
    : endpoints[provider];
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (gemini) headers['x-goog-api-key'] = key;
  else if (provider !== 'ollama') headers.Authorization = 'Bearer ' + key;
  const body = gemini ? {
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    contents: messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
  } : { model, stream: true, messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages };

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error(provider === 'ollama' ? 'Could not connect to Ollama. Start Ollama and try again.' : 'Could not connect to the provider. Check your connection and try again.');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as Packet | null;
    throw providerError(response.status, error?.error?.message);
  }
  if (!response.body) throw new Error('The provider returned an empty response.');

  const isSse = response.headers.get('content-type')?.includes('text/event-stream');
  let received = false;
  let finished = false;
  function consume(payload: string) {
    if (payload.trim() === '[DONE]') {
      finished = true;
      return;
    }
    const packet = JSON.parse(payload) as Packet;
    if (packet.error) throw providerError(packet.error.code, packet.error.message);
    const candidate = packet.candidates?.[0];
    const choice = packet.choices?.[0];
    if (choice?.finish_reason === 'error') throw providerError(undefined);
    if (candidate?.finishReason || choice?.finish_reason) finished = true;
    const text = gemini
      ? candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('')
      : choice?.delta?.content;
    if (text) {
      received = true;
      onText(text);
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function flushEvents() {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) consume(data);
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (isSse) flushEvents();
    }
    buffer += decoder.decode();
    if (isSse) {
      buffer += '\n\n';
      flushEvents();
    } else {
      const packet = JSON.parse(buffer);
      const content = packet.choices?.[0]?.message?.content;
      if (content) {
        received = true;
        onText(content);
      } else consume(buffer);
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new Error('The response was interrupted or unreadable. Try again.');
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!received) throw new Error('The model returned no text. Try rephrasing your request or choosing another model.');
  if (isSse && !finished) throw new Error('The stream ended early. The partial response is shown above.');
}
