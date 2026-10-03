// Markdown for the assistant transcript. The text comes from the model, which reads documents
// from outside, so it is untrusted: raw HTML is shown as text, images become links, and only
// http(s) and mailto links are kept. marked escapes all other text and code itself.
import { Marked } from 'marked';
import { esc } from './ui.js';

const safeHref = (href) => (/^(https?:|mailto:)/i.test(String(href ?? '').trim()) ? String(href).trim() : null);

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => esc(text),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = safeHref(href);
      return url ? `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
    image({ href, text }) {
      const url = safeHref(href);
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text || url)}</a>` : esc(text);
    },
  },
});

export const markdown = (text) => marked.parse(String(text ?? ''), { async: false });
