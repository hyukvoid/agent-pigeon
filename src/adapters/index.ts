/**
 * Adapter registry — detection, discovery and loading across agent sources.
 *
 * Support levels are honest (principle: do not fake support). A vendor adapter
 * is only FULL when every event class in its logs maps losslessly; PARTIAL
 * lists exactly what cannot be recovered; anything not implemented here is
 * UNAVAILABLE, never "supported".
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSessionModel } from '../pigeon/process.js';
import type { AdapterInfo, PigeonEvent, SessionModel } from '../pigeon/types.js';
import { looksLikePigeonJsonl, parsePigeonJsonl } from './generic-jsonl.js';
import { looksLikeCodexRollout, parseCodexPigeonSession } from './codex.js';
import { looksLikeClaudeSession, parseClaudePigeonSession } from './claude.js';
import { looksLikeZCodeModelIo, parseZCodePigeonSession } from './zcode.js';

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
  {
    id: 'zcode',
    label: 'ZCode',
    level: 'EXPERIMENTAL',
    limitations: [
      'reads the model-io rollout debug log — may be truncated, disabled, or change between ZCode versions',
      'tool results carry only an error flag, no exit codes',
      'no explicit session end record',
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    level: 'UNAVAILABLE',
    limitations: [
      'no local session storage found on the reference machine to verify a format against; no adapter written rather than guessing one',
    ],
  },
];

export type DetectedAdapter = 'generic-jsonl' | 'codex' | 'claude' | 'zcode' | null;

/**
 * Sniff the first lines of a session file to pick an adapter.
 *
 * Cheap string fingerprints run first so discovery over hundreds of files
 * never pays for speculative JSON parsing; each candidate is still confirmed
 * by its real sniffer before we commit.
 */
export function detectAdapter(text: string): DetectedAdapter {
  if (text.includes('"type":"response_item"') || text.includes('"type":"session_meta"')) {
    if (looksLikeCodexRollout(text)) return 'codex';
  }
  if (text.includes('"toolCalls"')) {
    if (looksLikeZCodeModelIo(text)) return 'zcode';
  }
  if (text.includes('"parentUuid"') || text.includes('"file-history-snapshot"')) {
    if (looksLikeClaudeSession(text)) return 'claude';
  }
  if (text.includes('"sessionId"') && text.includes('"timestamp"')) {
    if (looksLikePigeonJsonl(text)) return 'generic-jsonl';
  }
  // Ambiguous head: fall back to the full sniffers in order.
  if (looksLikeCodexRollout(text)) return 'codex';
  if (looksLikeZCodeModelIo(text)) return 'zcode';
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
  if (adapter === 'zcode') {
    const r = parseZCodePigeonSession(text, fallbackId);
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

async function sniffFile(path: string): Promise<DiscoveredSessionFile | null> {
  try {
    const statInfo = await stat(path);
    if (statInfo.size === 0) return null;
    // Read a small head first — most session formats have short lines. Only
    // when the window holds no COMPLETE line (very long-line formats like
    // ZCode model-io) re-read a larger window. Partial reads via a file
    // handle: never load the whole (possibly multi-MB) file for a sniff.
    const probe = async (bytes: number): Promise<DetectedAdapter | null> => {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        const head = buffer.toString('utf8', 0, bytesRead);
        const lastNewline = head.lastIndexOf('\n');
        const window = lastNewline > 0 ? head.slice(0, lastNewline) : head;
        return window.length > 0 ? detectAdapter(window) : null;
      } finally {
        await handle.close();
      }
    };
    const adapterId = (await probe(64 * 1024)) ?? (await probe(256 * 1024));
    if (adapterId === null) return null;
    return { path, adapterId, mtimeMs: statInfo.mtimeMs, sizeBytes: statInfo.size };
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
  zcodeDir?: string;
  /** Extra roots scanned for .jsonl session files (e.g. workspace .pigeon/). */
  extraDirs?: string[];
  /** Cap per directory scan to keep discovery snappy on huge histories. */
  limit?: number;
}

/** Default local history locations (read-only). */
export function defaultSessionDirs(): { claudeDir: string; codexDir: string; zcodeDir: string } {
  return {
    claudeDir: join(homedir(), '.claude', 'projects'),
    codexDir: join(homedir(), '.codex', 'sessions'),
    zcodeDir: join(homedir(), '.zcode', 'cli', 'rollout'),
  };
}

/**
 * Discover session files across known agent history locations. Read-only:
 * nothing is written, hashed, or uploaded during discovery. Heads are read
 * concurrently to keep first-launch discovery fast on large histories.
 */
export async function discoverSessionFiles(opts: DiscoverOptions = {}): Promise<DiscoveredSessionFile[]> {
  const defaults = defaultSessionDirs();
  const roots = [
    ...(opts.extraDirs ?? []),
    opts.claudeDir ?? defaults.claudeDir,
    opts.codexDir ?? defaults.codexDir,
    opts.zcodeDir ?? defaults.zcodeDir,
  ];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const path of walkJsonl(root)) {
      if (!seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  const found: DiscoveredSessionFile[] = [];
  const CONCURRENCY = 24;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      if (path === undefined) break;
      const sniffed = await sniffFile(path);
      if (sniffed !== null) found.push(sniffed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return opts.limit !== undefined ? found.slice(0, opts.limit) : found;
}
