import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDesktopApp, openExternal } from './open-external';

describe('openExternal', () => {
  const originalLocation = window.location;
  const originalFetch = globalThis.fetch;
  const originalOpen = window.open;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
    globalThis.fetch = vi.fn();
    window.open = vi.fn().mockReturnValue({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    window.open = originalOpen;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('rejects empty and invalid protocols', async () => {
    expect(await openExternal('')).toBe(false);
    expect(await openExternal('javascript:alert(1)')).toBe(false);
    expect(await openExternal('file:///etc/passwd')).toBe(false);
  });

  it('calls Tauri IPC if window.__TAURI_INTERNALS__.invoke is available', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI_INTERNALS__ = { invoke };

    const result = await openExternal('https://gitlab.com/mr/123');

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://gitlab.com/mr/123' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls Tauri IPC if window.__TAURI__.core.invoke is available', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI__ = { core: { invoke } };

    const result = await openExternal('https://jira.atlassian.com/browse/PROJ-1');

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://jira.atlassian.com/browse/PROJ-1' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('falls back to connector endpoint if Tauri invoke fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('Tauri command error'));
    (window as any).__TAURI_INTERNALS__ = { invoke };

    (globalThis.fetch as any).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await openExternal('https://gitlab.com/mr/123');

    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/connector/open-external'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-TLC-Client': '1' }),
        body: JSON.stringify({ url: 'https://gitlab.com/mr/123' }),
      }),
    );
  });

  it('falls back to window.open when running in normal browser mode', async () => {
    const result = await openExternal('https://google.com');

    expect(result).toBe(true);
    expect(window.open).toHaveBeenCalledWith('https://google.com', '_blank', 'noopener,noreferrer');
  });

  it('correctly detects desktop app mode', () => {
    expect(isDesktopApp()).toBe(false);

    (window as any).__TAURI_INTERNALS__ = {};
    expect(isDesktopApp()).toBe(true);

    delete (window as any).__TAURI_INTERNALS__;
    (window as any).__TAURI__ = {};
    expect(isDesktopApp()).toBe(true);
  });

  it('initExternalLinkHandler intercepts anchor clicks in desktop mode', async () => {
    const { initExternalLinkHandler } = await import('./open-external');
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as any).__TAURI_INTERNALS__ = { invoke };

    initExternalLinkHandler();

    // Create a mock link
    const link = document.createElement('a');
    link.href = 'https://gitlab.com/project/mr/42';
    link.target = '_blank';
    document.body.appendChild(link);

    // Click it
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://gitlab.com/project/mr/42' });

    // Internal hash links should NOT be prevented or invoked
    const hashLink = document.createElement('a');
    hashLink.href = '#/mr-review';
    document.body.appendChild(hashLink);

    invoke.mockClear();
    const hashClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    hashLink.dispatchEvent(hashClickEvent);

    expect(hashClickEvent.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();

    link.remove();
    hashLink.remove();
  });
});

