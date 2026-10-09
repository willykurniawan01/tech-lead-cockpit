export interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  message: string;
  /** Optional link shown as a button, e.g. to the finished analysis. */
  action?: { label: string; href: string };
}

let seq = 0;

class ToastStore {
  items = $state<Toast[]>([]);

  show(message: string, kind: Toast['kind'] = 'info', ms = 3500, action?: Toast['action']) {
    const id = ++seq;
    this.items.push({ id, kind, message, action });
    setTimeout(() => this.dismiss(id), ms);
  }

  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
