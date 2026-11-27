import type { Buddy, Provider } from '../shared/protocol';

declare global { interface Window { buddy: Buddy } }

/** The preload bridge (electron/preload.ts). */
export const api = window.buddy;

export const providerNames: Record<Provider, string> = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', ollama: 'Ollama' };

/** Turns an IPC rejection into the message the main process threw. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.')
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
