import type { Mermaid } from 'mermaid';

let loader: Promise<Mermaid> | null = null;
let counter = 0;

/** Mermaid is ~1MB; load it only when a document actually has a diagram. */
function load(): Promise<Mermaid> {
  loader ??= import('mermaid').then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      // Plain SVG text (no <foreignObject>) so diagrams can be rasterised to PNG for Confluence.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m;
  });
  return loader;
}

export async function parseMermaid(code: string): Promise<void> {
  const m = await load();
  await m.parse(code);
}

export async function renderMermaid(code: string): Promise<string> {
  const m = await load();
  const { svg } = await m.render(`tlc-mermaid-${++counter}`, code);
  return svg;
}

/** Rasterises a Mermaid SVG on a white background (Confluence pages are white in both themes). */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.documentElement;
  const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const width = vb.length === 4 && vb[2] > 0 ? vb[2] : Number.parseFloat(el.getAttribute('width') ?? '800') || 800;
  const height = vb.length === 4 && vb[3] > 0 ? vb[3] : Number.parseFloat(el.getAttribute('height') ?? '600') || 600;
  el.setAttribute('width', String(width));
  el.setAttribute('height', String(height));
  el.removeAttribute('style');

  const data = new XMLSerializer().serializeToString(el);
  const img = new Image();
  img.decoding = 'async';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Gagal membuat PNG'))), 'image/png'));
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
