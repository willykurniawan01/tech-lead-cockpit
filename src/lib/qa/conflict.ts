import { confirmDialog } from '../../components/confirm.svelte';
import { toasts } from '../../components/toast.svelte';
import { QaApiError } from './client';

/**
 * A save refused because someone else (another user, or a background agent) saved first. The
 * user's change is not stored; they are offered the latest version instead of an overwrite.
 * Returns true when the error was a conflict (handled here), false for any other error.
 */
export async function handleConflict(e: unknown, reload: () => Promise<unknown> | unknown): Promise<boolean> {
  if (!(e instanceof QaApiError) || e.code !== 'conflict') return false;
  const ok = await confirmDialog({ title: 'Sudah diubah orang lain', message: e.message, confirmText: 'Muat ulang', cancelText: 'Nanti' });
  if (ok) {
    await reload();
    toasts.show('Versi terbaru dimuat. Ulangi perubahan Anda bila masih perlu.', 'info', 4000);
  }
  return true;
}
