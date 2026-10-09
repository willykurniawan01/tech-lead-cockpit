import { toasts } from '../../components/toast.svelte';
import { remote } from './client';
import type { RemoteStatus } from './types';

const STOP_LABEL: Record<string, string> = {
  expired: 'durasi habis',
  phone: 'dimatikan dari HP',
  'too-many-failures': 'terlalu banyak percobaan gagal',
};

/** Shared Remote Access status for the topbar indicator and the settings modal. */
class RemoteStatusStore {
  status = $state<RemoteStatus | null>(null);
  now = $state(Date.now());
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = -1;
  private wasActive = false;
  private watchers = 0;

  /** Polls while something shows the status; faster while Remote is on. */
  watch(): () => void {
    if (this.watchers++ === 0) void this.poll();
    return () => {
      if (--this.watchers === 0) clearTimeout(this.timer);
    };
  }

  async refresh() {
    try {
      this.apply(await remote.status());
    } catch {
      /* connector down: the indicator stays as it was */
    }
  }

  apply(s: RemoteStatus) {
    if (this.seq >= 0 && s.connectionSeq > this.seq && s.lastConnection) toasts.show(`📱 ${s.lastConnection.deviceName} tersambung lewat Remote.`, 'info', 6000);
    if (this.wasActive && !s.active && s.lastStop && STOP_LABEL[s.lastStop.reason]) toasts.show(`Remote Cockpit nonaktif: ${STOP_LABEL[s.lastStop.reason]}.`, 'info', 6000);
    this.seq = s.connectionSeq;
    this.wasActive = s.active;
    this.status = s;
    this.now = Date.now();
  }

  private async poll() {
    clearTimeout(this.timer);
    await this.refresh();
    if (this.watchers > 0) this.timer = setTimeout(() => void this.poll(), this.status?.active ? 5_000 : 30_000);
  }

  get remainingMs(): number {
    return this.status?.expiresAt ? Date.parse(this.status.expiresAt) - this.now : 0;
  }
}

export const remoteStatus = new RemoteStatusStore();
