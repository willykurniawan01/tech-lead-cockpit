import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Cockpit keeps its data, and the Keychain namespace for its tokens. `TLC_PROFILE` (e.g.
 * `npm run dev:fresh` sets `test`) gives a separate data folder and Keychain entries, so a
 * first-run setup can be tried without touching the real app's data or tokens.
 */
export const PROFILE = (process.env.TLC_PROFILE ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);

const NAME = PROFILE ? `tech-lead-cockpit-${PROFILE}` : 'tech-lead-cockpit';

/** ~/.tech-lead-cockpit, or ~/.tech-lead-cockpit-<profile>. */
export const DATA_DIR = join(homedir(), `.${NAME}`);

/** Keychain service prefix: tech-lead-cockpit.jira, or tech-lead-cockpit-<profile>.jira. */
export const KEYCHAIN_PREFIX = NAME;
