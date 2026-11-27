import { limits } from './validation';

/** In-memory store for extracted attachment text, owned by the main process. */
export class AttachmentStore {
  private readonly items = new Map<string, string>();

  get size() { return this.items.size; }

  get characters() {
    return [...this.items.values()].reduce((total, text) => total + text.length, 0);
  }

  add(name: string, text: string) {
    if (this.items.has(name)) throw new Error('A document with this name is already attached.');
    if (this.items.size >= limits.attachments || this.characters + text.length > limits.attachmentCharacters) {
      throw new Error('Attachment limit reached. Remove a document before adding another.');
    }
    this.items.set(name, text);
    return { name, characters: text.length };
  }

  remove(name: string) { this.items.delete(name); }

  clear() { this.items.clear(); }

  list() { return [...this.items].map(([name, text]) => ({ name, text })); }
}
