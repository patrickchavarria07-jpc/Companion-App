import { extname } from 'node:path';
import { limits } from './validation';

/** In-memory store for extracted attachment text, owned by the main process. */
export class AttachmentStore {
  private readonly items = new Map<string, { text: string; source: string }>();

  get size() { return this.items.size; }

  get characters() {
    return [...this.items.values()].reduce((total, item) => total + item.text.length, 0);
  }

  /**
   * Adds a document. `source` identifies the file (its path) so the same file can't be attached twice;
   * different files that share a name get a numbered display name, e.g. `notes (2).txt`.
   */
  add(name: string, text: string, source: string) {
    if ([...this.items.values()].some(item => item.source === source)) throw new Error('This document is already attached.');
    if (this.items.size >= limits.attachments || this.characters + text.length > limits.attachmentCharacters) {
      throw new Error('Attachment limit reached. Remove a document before adding another.');
    }
    const unique = this.uniqueName(name);
    this.items.set(unique, { text, source });
    return { name: unique, characters: text.length };
  }

  remove(name: string) { this.items.delete(name); }

  clear() { this.items.clear(); }

  list() { return [...this.items].map(([name, { text }]) => ({ name, text })); }

  private uniqueName(name: string) {
    if (!this.items.has(name)) return name;
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let index = 2;
    while (this.items.has(`${stem} (${index})${extension}`)) index++;
    return `${stem} (${index})${extension}`;
  }
}
