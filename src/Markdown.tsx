import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WebSource } from '../shared/protocol';

/** Only absolute web and mail links become clickable; the main process opens them in the system browser. */
const isExternal = (href: unknown): href is string => typeof href === 'string' && /^(https?:\/\/|mailto:)/i.test(href);

const components: Components = {
  a: ({ href, title, children }) => isExternal(href)
    ? <a href={href} target="_blank" rel="noreferrer noopener" title={title || href}>{children}</a>
    : <span>{children}</span>,
  // The CSP blocks remote images (and they could be used for tracking), so show them as links instead.
  img: ({ src, alt }) => isExternal(src)
    ? <a href={src} target="_blank" rel="noreferrer noopener" title={src}>{alt || 'Image link'}</a>
    : <span>{alt}</span>,
};

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  children?: MdNode[];
};

const skipTypes = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'image', 'html']);

function expandCitations(text: string, sources: WebSource[]): MdNode[] | undefined {
  const pattern = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
  let match: RegExpExecArray | null;
  let cursor = 0;
  let changed = false;
  const nodes: MdNode[] = [];

  while ((match = pattern.exec(text)) !== null) {
    const parts = match[1].split(',').map(part => Number(part.trim()));
    if (parts.some(num => !Number.isInteger(num) || num < 1 || num > sources.length)) continue;
    changed = true;
    if (match.index > cursor) nodes.push({ type: 'text', value: text.slice(cursor, match.index) });
    if (parts.length === 1) {
      const source = sources[parts[0] - 1];
      nodes.push({
        type: 'link',
        url: source.url,
        title: source.title ? `${source.title} (${source.url})` : source.url,
        children: [{ type: 'text', value: `[${parts[0]}]` }],
      });
    } else {
      parts.forEach((num, idx) => {
        if (idx > 0) nodes.push({ type: 'text', value: ' ' });
        const source = sources[num - 1];
        nodes.push({
          type: 'link',
          url: source.url,
          title: source.title ? `${source.title} (${source.url})` : source.url,
          children: [{ type: 'text', value: `[${num}]` }],
        });
      });
    }
    cursor = match.index + match[0].length;
  }

  if (!changed) return undefined;
  if (cursor < text.length) nodes.push({ type: 'text', value: text.slice(cursor) });
  return nodes;
}

function walkAst(node: MdNode, sources: WebSource[]) {
  if (skipTypes.has(node.type) || !Array.isArray(node.children)) return;
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    if (child.type === 'text' && typeof child.value === 'string') {
      const replacement = expandCitations(child.value, sources);
      if (replacement) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    } else {
      walkAst(child, sources);
    }
  }
}

const basePlugins = [remarkGfm];

/** Renders model output as Markdown. Raw HTML is shown as text, never rendered. */
export const Markdown = memo(function Markdown({ text, sources }: { text: string; sources?: WebSource[] }) {
  const plugins = useMemo(() => {
    if (!sources?.length) return basePlugins;
    const linkCitations = () => (tree: MdNode) => walkAst(tree, sources);
    return [remarkGfm, linkCitations];
  }, [sources]);

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
