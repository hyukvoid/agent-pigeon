/**
 * Adapter registry — detection, discovery and loading across agent sources.
 *
 * Support levels are honest (principle: do not fake support). A vendor adapter
 * is only FULL when every event class in its logs maps losslessly; PARTIAL
 * lists exactly what cannot be recovered; anything not implemented here is
 * UNAVAILABLE, never "supported".
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSessionModel } from '../pigeon/process.js';
import type { AdapterInfo, PigeonEvent, SessionModel } from '../pigeon/types.js';
import { looksLikePigeonJsonl, parsePigeonJsonl } from './generic-jsonl.js';
import { looksLikeCodexRollout, parseCodexPigeonSession } from './codex.js';
import { looksLikeClaudeSession, parseClaudePigeonSession } from './claude.js';

export const ADAPTERS: AdapterInfo[] = [
  {
    id: 'generic-jsonl',
    label: 'Pigeon JSONL',
    level: 'FULL',
    limitations: [],
  },
  {
    id: 'codex',
    label: 'Codex',
    level: 'PARTIAL',
    limitations: [
      'no subagent/parallel-agent records in Codex logs',
      'test/build outcomes only as command exit codes, not structured results',
    ],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    level: 'PARTIAL',
    limitations: [
      'sessions have no explicit end event — completion status stays UNKNOWN',
      'sidechain (subagent) streams are grouped under one agent; the log does not link them to the Task call that spawned them',
    ],
  },
];

export type DetectedAdapter = 'generic-jsonl' | 'codex' | 'claude' | null;

/** Sniff the first lines of a session file to pick an adapter. */
export function detectAdapter(text: string): DetectedAdapter {
  if (looksLikeCodexRollout(text)) return 'codex';
  if (looksLikeClaudeSession(text)) return 'claude';
  if (looksLikePigeonJsonl(text)) return 'generic-jsonl';
  return null;
}

export interface LoadedSession {
  adapterId: Exclude<DetectedAdapter, null>;
  events: PigeonEvent[];
  warnings: string[];
}

export function loadSessionText(text: string, fallbackId: string): LoadedSession | null {
  const adapter = detectAdapter(text);
  if (adapter === null) return null;
  if (adapter === 'codex') {
    const r = parseCodexPigeonSession(text, fallbackId);
    return { adapterId: adapter, events: r.events, warnings: r.warnings };
  }
  if (adapter === 'claude') {
    const r = parseClaudePigeonSession(text, fallbackId);
    return { adapterId: adapter, events: r.events, warnings: r.warnings };
  }
  const r = parsePigeonJsonl(text, 'generic-jsonl');
  return { adapterId: adapter, events: r.events, warnings: r.warnings };
}

export function loadSessionFile(path: string): LoadedSession | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // vanished or unreadable between discovery and load
  }
  return loadSessionText(text, basename(path).replace(/\.jsonl$/u, ''));
}

/** Load AND process in one step — what every UI surface uses. */
export function loadSessionModel(path: string, opts = {}): SessionModel | null {
  const loaded = loadSessionFile(path);
  if (loaded === null || loaded.events.length === 0) return null;
  const model = buildSessionModel(loaded.events, { warnings: loaded.warnings, ...opts });
  return model;
}

export interface DiscoveredSessionFile {
  path: string;
  adapterId: Exclude<DetectedAdapter, null>;
  /** Last modified time in ms — used for "most recent" ordering. */
  mtimeMs: number;
  sizeBytes: number;
}

function sniffFile(path: string): DiscoveredSessionFile | null {
  try {
    const stat = statSync(path);
    if (stat.size === 0) return null;
    const head = readFileSync(path, 'utf8').slice(0, 16 * 1024);
    const adapterId = detectAdapter(head);
    if (adapterId === null) return null;
    return { path, adapterId, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkJsonl(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export interface DiscoverOptions {
  claudeDir?: string;
  codexDir?: string;
  /** Extra roots scanned for .jsonl session files (e.g. workspace .pigeon/). */
  extraDirs?: string[];
  /** Cap per directory scan to keep discovery snappy on huge histories. */
  limit?: number;
}

/** Default local history locations (read-only). */
export function defaultSessionDirs(): { claudeDir: string; codexDir: string } {
  return {
    claudeDir: join(homedir(), '.claude', 'projects'),
    codexDir: join(homedir(), '.codex', 'sessions'),
  };
}

/**
 * Discover session files across known agent history locations. Read-only:
 * nothing is written, hashed, or uploaded during discovery.
 */
export function discoverSessionFiles(opts: DiscoverOptions = {}): DiscoveredSessionFile[] {
  const defaults = defaultSessionDirs();
  const roots = [
    ...(opts.extraDirs ?? []),
    opts.claudeDir ?? defaults.claudeDir,
    opts.codexDir ?? defaults.codexDir,
  ];
  const found: DiscoveredSessionFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const sniffed = sniffFile(path);
      if (sniffed !== null) found.push(sniffed);
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return opts.limit !== undefined ? found.slice(0, opts.limit) : found;
}
