import type { IconName } from '../components/Icon.svelte';

/** The app's views (the hash route: #/<view>). */
export type View = 'dashboard' | 'assistant' | 'agents' | 'mr' | 'tad' | 'projects' | 'releases' | 'bugs' | 'teams' | 'whatsapp' | 'connections' | 'audit';

export interface NavItem {
  id: View;
  label: string;
  icon: IconName;
  /** One line under the label in the dropdown. */
  hint?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: IconName;
  items: NavItem[];
}

/** The top bar: groups by kind of work, a dropdown each (a single-item group is a plain link). */
export const GROUPS: NavGroup[] = [
  { id: 'home', label: 'Dashboard', icon: 'dashboard', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }] },
  {
    id: 'plan',
    label: 'Perencanaan',
    icon: 'doc',
    items: [
      { id: 'tad', label: 'TAD', icon: 'doc', hint: 'Susun & publish dokumen arsitektur' },
      { id: 'projects', label: 'Proyek', icon: 'list', hint: 'Progres, estimasi, tim & test E2E' },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    icon: 'merge',
    items: [
      { id: 'mr', label: 'MR Review', icon: 'merge', hint: 'Review merge request & cek task' },
      { id: 'releases', label: 'Rilis', icon: 'send', hint: 'Rilis & dokumen deploy' },
      { id: 'bugs', label: 'Bug Tracing', icon: 'bug', hint: 'Telusuri error lintas service' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    icon: 'sparkles',
    items: [
      { id: 'assistant', label: 'AI Assistant', icon: 'sparkles', hint: 'Chat asisten Tech Lead' },
      { id: 'agents', label: 'Agent Tasks', icon: 'bot', hint: 'Pekerjaan agent di background' },
    ],
  },
  {
    id: 'comms',
    label: 'Komunikasi',
    icon: 'chat',
    items: [
      { id: 'teams', label: 'Teams', icon: 'teams', hint: 'Chat & grup MS Teams' },
      { id: 'whatsapp', label: 'WhatsApp', icon: 'chat', hint: 'Draft balasan WhatsApp' },
    ],
  },
];

/** Settings-like views, as icons in the side rail. */
export const RAIL: NavItem[] = [
  { id: 'connections', label: 'Koneksi', icon: 'plug' },
  { id: 'audit', label: 'Audit log', icon: 'history' },
];

export const NAV: NavItem[] = [...GROUPS.flatMap((g) => g.items), ...RAIL];
