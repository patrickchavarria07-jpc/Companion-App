import { describe, expect, it } from 'vitest';
import { createNdjsonParser, createSseParser } from '../electron/stream';

describe('createSseParser', () => {
  it('handles events split across chunks, CRLF, comments, and multi-line data', () => {
    const events: string[] = [];
    const parser = createSseParser(data => events.push(data));
    parser.push(': keep-alive\n\ndata: {"a"');
    parser.push(':1}\r\n\r\ndata: line one\ndata: line two\n');
    expect(events).toEqual(['{"a":1}']);
    parser.push('\nevent: ignored\ndata:[DONE]');
    parser.end();
    expect(events).toEqual(['{"a":1}', 'line one\nline two', '[DONE]']);
  });

  it('rejects unbounded streams without event delimiters', () => {
    const parser = createSseParser(() => {}, 50);
    expect(() => parser.push('data: ' + 'x'.repeat(120))).toThrow(RangeError);
  });
});

describe('createNdjsonParser', () => {
  it('emits complete lines and flushes the remainder at the end', () => {
    const lines: string[] = [];
    const parser = createNdjsonParser(line => lines.push(line));
    parser.push('{"a":1}\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    parser.push(':2}\r\n\n');
    parser.push('{"c":3}');
    parser.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('rejects unbounded lines exceeding maxBuffer', () => {
    const parser = createNdjsonParser(() => {}, 40);
    expect(() => parser.push('x'.repeat(100))).toThrow(RangeError);
  });
});
