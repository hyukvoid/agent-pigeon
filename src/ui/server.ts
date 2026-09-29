/**
 * Agent Pigeon standalone local UI server — `agent-pigeon ui`.
 *
 * Local-first by construction:
 *  - binds to 127.0.0.1 only, never 0.0.0.0
 *  - reads local session files read-only; writes nothing; calls nothing
 *  - zero runtime dependencies (node:http + node:fs)
 *
 * The core (adapters + session processor) has no knowledge of HTTP — this
 * module is a thin boundary that turns SessionModels into JSON.
 *
 * API:
 *   GET /api/adapters            support matrix
 *   GET /api/sessions?limit=     processed session list (most recent first)
 *   GET /api/session?path=       full SessionModel + problem event ids
 *   GET /                        the flight recorder UI
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS, ADAPTER_CAPABILITIES, defaultSessionDirs, discoverSessionFiles, loadSessionText, detectAdapter } from '../adapters/index.js';
import type { DiscoveredSessionFile } from '../adapters/index.js';
import { assessAttention, attentionSortKey } from '../pigeon/attention.js';
import { buildSessionModel, isCodingSession } from '../pigeon/process.js';
import { problemEventIds } from '../pigeon/select.js';
import type { SessionModel } from '../pigeon/types.js';

/** A session whose file changed within this window counts as running. */
const RUNNING_WINDOW_MS = 120_000;
/** Discovery results are reused for this long (walking big histories is IO-bound). */
const DISCOVERY_TTL_MS = 5_000;

export interface UiServerOptions {
  port?: number;
  claudeDir?: string;
  codexDir?: string;
  zcodeDir?: string;
  extraDirs?: string[];
}

interface CachedModel {
  mtimeMs: number;
  running: boolean;
  adapterId: string;
  model: SessionModel;
  keepIds: string[];
  /** When this entry was computed and how long it took (cooldown input). */
  computedAt: number;
  computeMs: number;
  /** True when serving an older model because the file grew again recently. */
  stale?: boolean;
}

/** Files larger than this are never processed synchronously by the list. */
const LIST_MAX_BYTES = 4 * 1024 * 1024;
/** Huge live files that take this long to parse get a re-parse cooldown. */
const COOLDOWN_THRESHOLD_MS = 1_500;
const COOLDOWN_WINDOW_MS = 20_000;

export interface SessionListItem {
  path: string;
  adapterId: string;
  sessionId: string;
  label: string;
  /** Project/repo folder name when the log records a cwd. */
  project: string | null;
  /**
   * False for pure-conversation sessions (no file/command/tool evidence) —
   * the UI lists those under "Other sessions" instead of the main list.
   */
  coding: boolean;
  /** True when only metadata is known so far — processing still queued. */
  pending?: boolean;
  status: string;
  running: boolean;
  /** Radar attention tier (1 = needs attention most). Absent while pending. */
  attentionTier?: number;
  attentionLabel?: string;
  /** Headline problem summary for the radar (null when clear). */
  problemCategory?: string | null;
  problemSummary?: string | null;
  recoveryState?: string | null;
  /** Human label of the last observable activity, e.g. "ran npm test". */
  lastObserved?: string | null;
  durationMs: number | null;
  lastActivityMs: number;
  problems: number;
  recovered: number;
  unresolved: number;
  agents: number;
  filesChanged: number;
  sizeBytes: number;
}

const HUMANIZED_TYPES = new Set([
  'FILE_READ', 'FILE_CREATED', 'FILE_CHANGED', 'FILE_DELETED',
  'COMMAND_STARTED', 'COMMAND_COMPLETED',
  'TEST_STARTED', 'TEST_PASSED', 'TEST_FAILED',
  'BUILD_STARTED', 'BUILD_PASSED', 'BUILD_FAILED',
]);

/** "Last observed" label: the most recent observable action, evidence-only. */
export function lastObservedLabel(model: SessionModel): string | null {
  const timeline = model.timeline;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i]?.event;
    if (event === undefined || !HUMANIZED_TYPES.has(event.type)) continue;
    switch (event.type) {
      case 'TEST_PASSED': return 'tests passed';
      case 'TEST_FAILED': return 'tests failed';
      case 'BUILD_PASSED': return 'build passed';
      case 'BUILD_FAILED': return 'build failed';
      case 'COMMAND_STARTED':
      case 'COMMAND_COMPLETED':
        return `ran ${trim(event.command ?? event.toolName ?? 'a command')}`;
      case 'FILE_CHANGED': return `modified ${trim(event.filePath ?? 'a file')}`;
      case 'FILE_CREATED': return `created ${trim(event.filePath ?? 'a file')}`;
      case 'FILE_DELETED': return `deleted ${trim(event.filePath ?? 'a file')}`;
      case 'FILE_READ': return `read ${trim(event.filePath ?? 'a file')}`;
      default: return trim(event.summary ?? null);
    }
  }
  // No file/command/test activity at all — fall back to the last event that
  // carries any summary (an error, a message), skipping bookkeeping events.
  for (let i = timeline.length - 1; i >= 0; i--) {
    const event = timeline[i]?.event;
    if (event === undefined) continue;
    if (event.type === 'SESSION_STARTED' || event.type === 'SESSION_COMPLETED') continue;
    if (typeof event.summary === 'string' && event.summary.length > 0) return trim(event.summary);
    if (event.type === 'ERROR') return 'reported an error';
  }
  return null;
}

function trim(text: string | null, max = 60): string {
  if (text === null) return 'activity';
  const clean = text.replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function uiAssetsRoot(): string {
  // dist/src/ui/server.js → three levels up is the repo/package root → /ui
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ui');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export class PigeonUi {
  private readonly opts: UiServerOptions;
  private readonly cache = new Map<string, CachedModel>();
  private discovery: { at: number; files: DiscoveredSessionFile[] } | Promise<DiscoveredSessionFile[]> | null = null;

  constructor(opts: UiServerOptions = {}) {
    this.opts = opts;
  }

  private discoveryOptions(): { claudeDir?: string; codexDir?: string; zcodeDir?: string; extraDirs?: string[] } {
    const defaults = defaultSessionDirs();
    return {
      claudeDir: this.opts.claudeDir ?? defaults.claudeDir,
      codexDir: this.opts.codexDir ?? defaults.codexDir,
      zcodeDir: this.opts.zcodeDir ?? defaults.zcodeDir,
      extraDirs: this.opts.extraDirs,
    };
  }

  /** Discovery with a TTL; concurrent callers share one in-flight scan. */
  private async discovered(): Promise<DiscoveredSessionFile[]> {
    if (this.discovery !== null && 'files' in this.discovery && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) {
      return this.discovery.files;
    }
    if (this.discovery !== null && typeof (this.discovery as Promise<DiscoveredSessionFile[]>).then === 'function') {
      return this.discovery as Promise<DiscoveredSessionFile[]>;
    }
    const scan = discoverSessionFiles(this.discoveryOptions())
      .then((files) => {
        this.discovery = { at: Date.now(), files };
        if (this.cache.size > 600) {
          const keys = [...this.cache.keys()].slice(0, this.cache.size - 300);
          for (const key of keys) this.cache.delete(key);
        }
        return files;
      })
      .catch(() => {
        this.discovery = null;
        return [] as DiscoveredSessionFile[];
      });
    this.discovery = scan;
    return scan;
  }

  /** Load + process one session file, with mtime-keyed caching and a
   * re-parse cooldown for huge live files (a multi-MB rollout that is being
   * appended right now must not be fully re-parsed on every poll). */
  sessionAt(path: string): CachedModel | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      this.cache.delete(path);
      return null;
    }
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached;

    // Cooldown: the file grew, but the last full parse was expensive and
    // recent — serve the previous model marked stale instead of re-parsing.
    if (
      cached !== undefined && cached.computeMs > COOLDOWN_THRESHOLD_MS &&
      Date.now() - cached.computedAt < COOLDOWN_WINDOW_MS
    ) {
      return { ...cached, stale: true };
    }

    const computeStart = Date.now();
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      this.cache.delete(path);
      return null;
    }
    const loaded = loadSessionText(text, path.replace(/[\\\/]+/u, '/').split('/').pop()?.replace(/\.jsonl$/u, '') ?? 'session');
    if (loaded === null || loaded.events.length === 0) return null;
    const running = Date.now() - mtimeMs < RUNNING_WINDOW_MS &&
      !loaded.events.some((e) => e.type === 'SESSION_COMPLETED');
    const model = buildSessionModel(loaded.events, {
      warnings: loaded.warnings,
      running,
    });
    const entry: CachedModel = {
      mtimeMs,
      running,
      adapterId: loaded.adapterId,
      model,
      keepIds: [...problemEventIds(model)],
      computedAt: Date.now(),
      computeMs: Date.now() - computeStart,
    };
    this.cache.set(path, entry);
    return entry;
  }

  /**
   * Processed list for the sidebar, most recent activity first. A time
   * budget keeps the endpoint responsive on huge histories: sessions past
   * the budget are returned as metadata-only `pending` rows and fill in on
   * the next poll (per-file caching makes each pass cheaper).
   */
  async listSessions(limit = 80, budgetMs = 2_500): Promise<{ sessions: SessionListItem[]; scanned: number; pending: number }> {
    const files = await this.discovered();
    const items: SessionListItem[] = [];
    const startedAt = Date.now();
    let pending = 0;
    for (const file of files) {
      if (items.length >= limit) break;
      // Huge files are only processed once they are in cache (e.g. the user
      // opened them); otherwise they become pending rows instead of blocking
      // the endpoint for seconds.
      if (file.sizeBytes > LIST_MAX_BYTES && this.cache.get(file.path)?.mtimeMs !== file.mtimeMs) {
        if (items.length >= limit) break;
        items.push({
          path: file.path,
          adapterId: file.adapterId,
          sessionId: file.path.replace(/[\\\/]+/u, '/').split('/').pop() ?? file.path,
          label: file.path.replace(/[\\\/]+/u, '/').split('/').pop() ?? file.path,
          project: null,
          coding: true,
          pending: true,
          status: 'PENDING',
          running: false,
          durationMs: null,
          lastActivityMs: file.mtimeMs,
          problems: 0,
          recovered: 0,
          unresolved: 0,
          agents: 0,
          filesChanged: 0,
          sizeBytes: file.sizeBytes,
        });
        pending++;
        continue;
      }
      if (items.length >= 1 && Date.now() - startedAt > budgetMs) {
        // Metadata-only row; the client polls again and cached entries
        // resolve progressively.
        items.push({
          path: file.path,
          adapterId: file.adapterId,
          sessionId: file.path.replace(/[\\\/]+/u, '/').split('/').pop() ?? file.path,
          label: file.path.replace(/[\\\/]+/u, '/').split('/').pop() ?? file.path,
          project: null,
          coding: true,
          pending: true,
          status: 'PENDING',
          running: false,
          durationMs: null,
          lastActivityMs: file.mtimeMs,
          problems: 0,
          recovered: 0,
          unresolved: 0,
          agents: 0,
          filesChanged: 0,
          sizeBytes: file.sizeBytes,
        });
        pending++;
        continue;
      }
      const entry = this.sessionAt(file.path);
      if (entry === null) continue;
      const model = entry.model;
      const attention = assessAttention(model, entry.running);
      items.push({
        path: file.path,
        adapterId: entry.adapterId,
        sessionId: model.sessionId,
        label: model.task ?? model.sessionId,
        project: model.project,
        coding: isCodingSession(model),
        status: entry.running ? 'RUNNING' : model.outcome.status,
        running: entry.running,
        attentionTier: attention.tier,
        attentionLabel: attention.label,
        problemCategory: attention.headline?.category ?? null,
        problemSummary: attention.headline?.summary ?? null,
        recoveryState: attention.headline?.recoveryState ?? null,
        lastObserved: lastObservedLabel(model),
        durationMs: model.durationMs,
        lastActivityMs: file.mtimeMs,
        problems: model.problems.length,
        recovered: model.outcome.recovered,
        unresolved: model.outcome.unresolved,
        agents: model.outcome.agents,
        filesChanged: model.outcome.filesChanged,
        sizeBytes: file.sizeBytes,
      });
    }
    return { sessions: items, scanned: files.length, pending };
  }

  private async handleApi(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
    const sendJson = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/adapters') {
      sendJson(200, { adapters: ADAPTERS, capabilities: ADAPTER_CAPABILITIES });
      return true;
    }
    if (url.pathname === '/api/sessions') {
      const limitParam = Number(url.searchParams.get('limit') ?? '80');
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(300, Math.floor(limitParam)) : 80;
      const result = await this.listSessions(limit);
      sendJson(200, {
        sessions: result.sessions,
        scanned: result.scanned,
        pending: result.pending,
        generatedAt: new Date().toISOString(),
      });
      return true;
    }
    if (url.pathname === '/api/session') {
      const path = url.searchParams.get('path') ?? '';
      if (!path.endsWith('.jsonl')) {
        sendJson(400, { error: 'path must be a .jsonl session file' });
        return true;
      }
      const entry = this.sessionAt(resolve(path));
      if (entry === null) {
        sendJson(404, { error: 'no readable session at this path' });
        return true;
      }
      sendJson(200, {
        path: resolve(path),
        adapterId: entry.adapterId,
        running: entry.running,
        stale: entry.stale === true,
        model: entry.model,
        problemEventIds: entry.keepIds,
      });
      return true;
    }
    if (url.pathname === '/api/dirs') {
      sendJson(200, this.discoveryOptions());
      return true;
    }
    return false;
  }

  private serveAsset(pathname: string, res: ServerResponse): void {
    const root = uiAssetsRoot();
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
    const target = normalize(join(root, rel));
    if (!target.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const body = readFileSync(target);
      res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  handler(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      this.serveAsset(url.pathname, res);
      return;
    }
    this.handleApi(req, url, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unknown endpoint' }));
        }
      })
      .catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  }

  listen(port = 7676): Promise<Server> {
    const server = createServer((req, res) => this.handler(req, res));
    return new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolvePromise(server));
    });
  }
}
