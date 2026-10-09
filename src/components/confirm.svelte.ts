export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

class ConfirmState {
  open = $state(false);
  title = $state('Konfirmasi');
  message = $state('');
  confirmText = $state('Ya, Lanjutkan');
  cancelText = $state('Batal');
  danger = $state(false);
  private resolveFn?: (value: boolean) => void;

  ask(options: ConfirmOptions | string): Promise<boolean> {
    const opts = typeof options === 'string' ? { message: options } : options;
    this.title = opts.title ?? 'Konfirmasi';
    this.message = opts.message;
    this.confirmText = opts.confirmText ?? 'Ya, Lanjutkan';
    this.cancelText = opts.cancelText ?? 'Batal';
    this.danger = opts.danger ?? false;
    this.open = true;

    return new Promise<boolean>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  confirm() {
    this.open = false;
    const fn = this.resolveFn;
    this.resolveFn = undefined;
    fn?.(true);
  }

  cancel() {
    this.open = false;
    const fn = this.resolveFn;
    this.resolveFn = undefined;
    fn?.(false);
  }
}

export const confirmState = new ConfirmState();
export const confirmDialog = (options: ConfirmOptions | string) => confirmState.ask(options);
