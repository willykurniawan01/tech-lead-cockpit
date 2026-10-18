import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Figwright (github.com/awdr74100/figwright, MIT): an MCP server that reads Figma through a plugin
 * running in the user's Figma desktop app (Plugin API over a local WebSocket), so reads don't
 * count against Figma's REST/MCP quotas (6 calls a month on a View/Collab seat). Cockpit hands it
 * to Claude CLI runs with --mcp-config (nothing in the user's own Claude settings) and allows only
 * its read tools: the write tools are never in --allowedTools, so they are refused.
 */

/** Pinned: a new release is checked before it is used. */
export const FIGWRIGHT_VERSION = '0.6.0';

/**
 * Read tools the TAD generator needs. Left out on purpose: tools that write to Figma, tools that
 * write files on disk (save_screenshots, export_pdf, …), local-project scanners, and get_document
 * (a whole page at full fidelity floods the context; search_nodes / get_design_context do it lean).
 */
export const FIGWRIGHT_READ_TOOLS = [
  'ping',
  'list_files',
  'use_file',
  'get_metadata',
  'get_pages',
  'get_selection',
  'search_nodes',
  'get_design_context',
  'get_node',
  'get_nodes_info',
  'scan_text_nodes',
  'scan_nodes_by_types',
  'get_screenshot',
  'get_annotations',
  'get_reactions',
  'get_local_components',
  'get_component_api',
  'get_styles',
  'get_variable_defs',
].map((t) => `mcp__figwright__${t}`);

/** npx next to the Node that runs Cockpit (its shebang needs that node on PATH), else a usual install. */
export function findNpx(execPath = process.execPath, exists: (p: string) => boolean = existsSync): string {
  const candidates = [join(dirname(execPath), 'npx'), join(homedir(), '.local/bin/npx'), '/opt/homebrew/bin/npx', '/usr/local/bin/npx'];
  return candidates.find((p) => exists(p)) ?? 'npx';
}

/** The --mcp-config JSON for a Claude CLI run. */
export function figwrightMcpConfig(npx = findNpx()): string {
  const bin = npx.includes('/') ? dirname(npx) : '';
  return JSON.stringify({
    mcpServers: {
      figwright: {
        command: npx,
        args: ['-y', `@figwright/mcp@${FIGWRIGHT_VERSION}`],
        env: { PATH: [bin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') },
      },
    },
  });
}
