// POC-04C.2 — logical-attempt study (aggregates only).
// (a) Claude: tool_use calls per assistant message (batch size distribution)
// (b) Codex: inter-implementation time gaps inside unverified stretches
// (c) both: share of implementation events touching test-file paths
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCodexSessionJsonl } from '../dist/src/replay/codex.js';
import { parseClaudeSessionJsonl } from '../dist/src/replay/claude.js';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;

// (a) claude batch sizes
const claudeFiles = walk(join(homedir(), '.claude', 'projects'));
const batchSize = {};
let claudeImplEvents = 0;
let claudeImplTestShare = 0;
let claudeBatchesWithImpl = 0;
let claudeImplBatchesMulti = 0;
for (const f of claudeFiles) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    const uses = content.filter((c) => c.type === 'tool_use');
    if (uses.length === 0) continue;
    const implUses = uses.filter((c) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name));
    if (implUses.length === 0) continue;
    claudeBatchesWithImpl++;
    batchSize[uses.length] = (batchSize[uses.length] ?? 0) + 1;
    if (implUses.length > 1) claudeImplBatchesMulti++;
    for (const u of implUses) {
      claudeImplEvents++;
      const fp = u.input?.file_path;
      if (typeof fp === 'string' && TEST_PATH.test(fp)) claudeImplTestShare++;
    }
  }
}

// (b) codex: inter-impl gaps within unverified stretches + test-path share
const codexFiles = walk(join(homedir(), '.codex', 'sessions'));
const gaps = [];
let codexImplEvents = 0;
let codexImplTestShare = 0;
for (const f of codexFiles) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const s = parseCodexSessionJsonl(text);
  const impls = s.events.filter((e) => e.eventType === 'implementation');
  codexImplEvents += impls.length;
  for (let i = 1; i < impls.length; i++) {
    const a = impls[i - 1], b = impls[i];
    if (a.timestampOffset !== null && b.timestampOffset !== null) {
      gaps.push(b.timestampOffset - a.timestampOffset);
    }
  }
  // test-path share: codex adapter stores path-hash only, so sample via marker lines is
  // not available here; skip codex test-share (claude covers the question).
}
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
const buckets = { '<=10s': 0, '10-60s': 0, '1-5min': 0, '5-30min': 0, '30min-2h': 0, '>2h': 0 };
for (const g of gaps) {
  if (g <= 10_000) buckets['<=10s']++;
  else if (g <= 60_000) buckets['10-60s']++;
  else if (g <= 300_000) buckets['1-5min']++;
  else if (g <= 1_800_000) buckets['5-30min']++;
  else if (g <= 7_200_000) buckets['30min-2h']++;
  else buckets['>2h']++;
}

console.log(JSON.stringify({
  claude: {
    batchesWithImpl: claudeBatchesWithImpl,
    multiImplBatches: claudeImplBatchesMulti,
    batchSizeDistribution: Object.fromEntries(Object.entries(batchSize).sort((x, y) => Number(x[0]) - Number(y[0])).slice(0, 10)),
    implEvents: claudeImplEvents,
    implTestPathShare: claudeImplTestShare,
  },
  codex: {
    implEvents: codexImplEvents,
    interImplGaps: gaps.length,
    gapP50: gaps.length ? `${(q(0.5) / 1000).toFixed(1)}s` : null,
    gapP90: gaps.length ? `${(q(0.9) / 1000).toFixed(1)}s` : null,
    gapBuckets: buckets,
  },
}, null, 1));
