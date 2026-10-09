import { api, isDesktopBundle } from './api-base';

/**
 * Checks if running inside the Tauri desktop app (packaged bundle or tauri dev).
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as any;
  return (
    isDesktopBundle() ||
    typeof win.__TAURI_INTERNALS__ !== 'undefined' ||
    typeof win.__TAURI__ !== 'undefined'
  );
}

/**
 * Opens an external URL in the user's default web browser.
 * In desktop app mode:
 *   1. Calls Tauri native command `open_external` (macOS /usr/bin/open)
 *   2. Falls back to connector endpoint POST /api/connector/open-external
 * In web browser mode:
 *   Falls back to standard window.open(url, '_blank')
 */
export async function openExternal(rawUrl: string): Promise<boolean> {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const url = rawUrl.trim();
  if (!url) return false;

  // Allow only safe external protocols
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
    return false;
  }

  const win = window as any;

  if (isDesktopApp()) {
    // 1. Try Tauri IPC command
    const invoke = win.__TAURI_INTERNALS__?.invoke ?? win.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      try {
        await invoke('open_external', { url });
        return true;
      } catch (e) {
        console.warn('[openExternal] Tauri IPC failed, falling back to connector:', e);
      }
    }

    // 2. Try connector fallback endpoint
    try {
      const res = await fetch(api('/api/connector/open-external'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TLC-Client': '1',
        },
        body: JSON.stringify({ url }),
      });
      if (res.ok) return true;
    } catch (e) {
      console.warn('[openExternal] Connector fallback failed:', e);
    }
  }

  // 3. Fallback for browser or if desktop handlers failed
  try {
    const targetWin = win.__originalWindowOpen
      ? win.__originalWindowOpen(url, '_blank', 'noopener,noreferrer')
      : window.open(url, '_blank', 'noopener,noreferrer');
    return !!targetWin;
  } catch {
    return false;
  }
}

let initialized = false;

/**
 * Registers global handlers so that any external link (<a target="_blank"> or http(s)://)
 * and window.open calls open in the external system browser instead of being ignored by WKWebView.
 */
export function initExternalLinkHandler(): void {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;

  const win = window as any;
  if (!win.__originalWindowOpen) {
    win.__originalWindowOpen = window.open.bind(window);
  }

  // Only override navigation when running in desktop app
  if (!isDesktopApp()) return;

  // Override window.open for programmatic calls
  window.open = (url?: string | URL, target?: string, features?: string) => {
    const urlStr = typeof url === 'string' ? url : url?.toString();
    if (urlStr && (urlStr.startsWith('http://') || urlStr.startsWith('https://') || urlStr.startsWith('mailto:'))) {
      openExternal(urlStr).catch((err) => console.error('[openExternal] window.open failed:', err));
      return null;
    }
    return win.__originalWindowOpen(url, target, features);
  };

  // Intercept clicks on anchor tags globally in capture phase
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;

      // Ignore internal hash routes (e.g. #/dashboard, #/agents) and javascript:
      if (href.startsWith('#') || href.startsWith('javascript:')) return;

      const isBlank = anchor.target === '_blank';
      const isExternalProto = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:');

      if (isBlank || isExternalProto) {
        event.preventDefault();
        event.stopPropagation();
        openExternal(href).catch((err) => console.error('[openExternal] click failed:', err));
      }
    },
    true, // capture phase
  );
}
