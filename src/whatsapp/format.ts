import { escapeXml } from '../lib/markdown/shared';

/**
 * WhatsApp text formatting (*bold*, _italic_, ~strike~, ```mono```, `code`) to safe HTML.
 * The text is escaped first, so message content can never inject markup.
 */
export function formatWaText(text: string): string {
  let html = escapeXml(text);
  html = html.replace(/```([\s\S]+?)```/g, '<code class="block">$1</code>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1<strong>$2</strong>');
  html = html.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])~(?!\s)([^~\n]+?)~(?=$|[\s).,!?:;])/g, '$1<s>$2</s>');
  // Stop before an escaped quote or trailing punctuation so `"https://x.id".` links cleanly.
  html = html.replace(/(https?:\/\/[^\s<]+?)(?=&quot;|[.,!?:;)]*(?:\s|<|$))/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return html;
}
