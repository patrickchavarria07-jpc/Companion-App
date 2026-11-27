import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Only absolute web and mail links become clickable; the main process opens them in the system browser. */
const isExternal = (href: unknown): href is string => typeof href === 'string' && /^(https?:\/\/|mailto:)/i.test(href);

const components: Components = {
  a: ({ href, children }) => isExternal(href)
    ? <a href={href} target="_blank" rel="noreferrer noopener" title={href}>{children}</a>
    : <span>{children}</span>,
  // The CSP blocks remote images (and they could be used for tracking), so show them as links instead.
  img: ({ src, alt }) => isExternal(src)
    ? <a href={src} target="_blank" rel="noreferrer noopener" title={src}>{alt || 'Image link'}</a>
    : <span>{alt}</span>,
};

const plugins = [remarkGfm];

/** Renders model output as Markdown. Raw HTML is shown as text, never rendered. */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown></div>;
}
