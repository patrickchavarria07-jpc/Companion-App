export const defaultMaxBufferCharacters = 1_000_000;

/** Incremental Server-Sent Events parser. Calls `onData` with the joined `data:` lines of each event. */
export function createSseParser(onData: (data: string) => void, maxBuffer = defaultMaxBufferCharacters) {
  let buffer = '';
  function flush() {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    if (buffer.length > maxBuffer) throw new RangeError('Stream buffer limit exceeded.');
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) onData(data);
    }
  }
  return {
    push(text: string) {
      if (buffer.length + text.length > maxBuffer * 2) throw new RangeError('Stream buffer limit exceeded.');
      buffer += text;
      flush();
    },
    end() { buffer += '\n\n'; flush(); },
  };
}

/** Incremental newline-delimited JSON parser. Calls `onLine` with each non-empty line. */
export function createNdjsonParser(onLine: (line: string) => void, maxBuffer = defaultMaxBufferCharacters) {
  let buffer = '';
  function flush(final: boolean) {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : lines.pop() ?? '';
    if (buffer.length > maxBuffer) throw new RangeError('Stream buffer limit exceeded.');
    for (const line of lines) if (line.trim()) onLine(line);
  }
  return {
    push(text: string) {
      if (buffer.length + text.length > maxBuffer * 2) throw new RangeError('Stream buffer limit exceeded.');
      buffer += text;
      flush(false);
    },
    end() { flush(true); },
  };
}
