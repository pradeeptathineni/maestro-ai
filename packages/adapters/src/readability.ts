import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ExtractedDocument {
  title: string;
  text: string;
  excerpt: string;
  lostStructuredContent: boolean;
}

export function extractReadableHtml(html: string, sourceUrl: string): ExtractedDocument {
  if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) throw new RangeError('html_too_large');
  const document = new JSDOM(html, {
    url: sourceUrl,
    runScripts: undefined,
    resources: undefined,
  }).window.document;
  const lostStructuredContent = Boolean(document.querySelector('table, pre, code'));
  for (const unsafe of document.querySelectorAll('script, style, iframe, object, embed, form')) {
    unsafe.remove();
  }
  const article = new Readability(document, { maxElemsToParse: 20_000 }).parse();
  if (!article?.textContent) throw new TypeError('readability_no_content');
  const text = article.textContent.replace(/\s+/g, ' ').trim();
  return {
    title: article.title || document.title || 'Untitled source',
    text,
    excerpt: text.slice(0, 2_000),
    lostStructuredContent,
  };
}
