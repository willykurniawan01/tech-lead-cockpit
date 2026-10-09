import type { AttachmentUpload } from '../lib/confluence/api-types';
import type { DiagramAttachment } from '../lib/confluence/storage';
import { blobToBase64, renderMermaid, svgToPng } from '../lib/markdown/mermaid';
import { renderPreview } from '../lib/markdown/preview';
import { slugify } from '../lib/markdown/shared';

export function fileSlug(title: string): string {
  return slugify(title.replace(/^TAD\s+[—-]\s+/, '')) || 'tad';
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, type: string) {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

export async function diagramPngs(diagrams: DiagramAttachment[]): Promise<{ filename: string; blob: Blob }[]> {
  const out = [];
  for (const d of diagrams) out.push({ filename: d.filename, blob: await svgToPng(await renderMermaid(d.code)) });
  return out;
}

export async function diagramUploads(diagrams: DiagramAttachment[]): Promise<AttachmentUpload[]> {
  const pngs = await diagramPngs(diagrams);
  return Promise.all(pngs.map(async (p) => ({ filename: p.filename, contentType: 'image/png', base64: await blobToBase64(p.blob) })));
}

/**
 * Rich-text clipboard copy for pasting into the Confluence editor when no API access is
 * set up. The editor keeps headings, lists, tables and images but drops custom classes,
 * so callouts and lozenges are flattened into plain formatting.
 */
export async function copyForConfluence(md: string): Promise<void> {
  const { html, diagrams } = renderPreview(md);
  const root = document.createElement('div');
  root.innerHTML = html;

  for (const el of root.querySelectorAll<HTMLElement>('[data-mermaid]')) {
    const code = diagrams[Number(el.dataset.mermaid)];
    try {
      const png = await svgToPng(await renderMermaid(code));
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${await blobToBase64(png)}`;
      img.alt = 'Diagram';
      el.replaceWith(img);
    } catch {
      const pre = document.createElement('pre');
      pre.textContent = code;
      el.replaceWith(pre);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('.callout')) {
    const quote = document.createElement('blockquote');
    const title = el.querySelector('.callout-title');
    if (title) {
      const strong = document.createElement('strong');
      strong.textContent = `${title.textContent}: `;
      title.remove();
      quote.append(strong);
    }
    quote.append(...el.childNodes);
    el.replaceWith(quote);
  }
  for (const el of root.querySelectorAll<HTMLElement>('.lozenge')) {
    const strong = document.createElement('strong');
    strong.textContent = el.textContent;
    el.replaceWith(strong);
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([root.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([md], { type: 'text/plain' }),
    }),
  ]);
}
