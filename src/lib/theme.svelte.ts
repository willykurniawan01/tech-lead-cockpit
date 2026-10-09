export type ThemeChoice = 'light' | 'dark';

const KEY = 'tlc.theme';

function read(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** Light/dark preference; without an explicit choice the OS setting applies. */
class Theme {
  choice = $state<ThemeChoice | null>(read());
  private systemDark = $state(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);

  constructor() {
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => (this.systemDark = e.matches));
    }
    this.apply();
  }

  get effective(): ThemeChoice {
    return this.choice ?? (this.systemDark ? 'dark' : 'light');
  }

  set(choice: ThemeChoice) {
    this.choice = choice;
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      /* the choice still applies for this session */
    }
    this.apply();
  }

  private apply() {
    if (typeof document === 'undefined') return;
    if (this.choice) document.documentElement.dataset.theme = this.choice;
    else delete document.documentElement.dataset.theme;
  }
}

export const theme = new Theme();
