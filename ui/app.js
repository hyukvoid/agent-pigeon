/* Agent Pigeon flight recorder — vanilla JS, no external assets (local-first). */
'use strict';

const state = {
  sessions: [],
  scanned: 0,
  pending: 0,
  filter: 'all',
  query: '',
  selectedPath: null,
  session: null,          // { path, adapterId, running, model, problemEventIds }
  tab: 'timeline',
  messOnly: false,
  pollTimer: null,
  listTimer: null,
  listRefreshTimer: null,
};

const $ = (sel) => document.querySelector(sel);

const GLYPHS = {
  SESSION_STARTED: ['▶', 'ok'],
  SESSION_COMPLETED: ['■', 'dim'],
  AGENT_STARTED: ['▶', 'run'],
  AGENT_COMPLETED: ['■', 'dim'],
  SUBAGENT_STARTED: ['⑃', 'run'],
  SUBAGENT_COMPLETED: ['⑃', 'dim'],
  MESSAGE: ['💬', 'dim'],
  TOOL_CALLED: ['🔧', 'dim'],
  TOOL_RESULT: ['↩', 'dim'],
  FILE_READ: ['👁', 'dim'],
  FILE_CREATED: ['+', 'ok'],
  FILE_CHANGED: ['✎', 'run'],
  FILE_DELETED: ['−', 'err'],
  COMMAND_STARTED: ['$', 'run'],
  COMMAND_COMPLETED: ['$ ', 'dim'],
  TEST_STARTED: ['🧪', 'run'],
  TEST_PASSED: ['✓', 'ok'],
  TEST_FAILED: ['✕', 'err'],
  BUILD_STARTED: ['⚙', 'run'],
  BUILD_PASSED: ['✓', 'ok'],
  BUILD_FAILED: ['✕', 'err'],
  ERROR: ['⚑', 'err'],
  CHECKPOINT: ['📍', 'dim'],
};

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m > 0) return m + 'm ' + String(r).padStart(2, '0') + 's';
  return r + 's';
}

function fmtOffset(model, ms) {
  const start = model.startedMs ?? 0;
  const s = Math.max(0, Math.round((ms - start) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function esc(s) { return s; } // textContent everywhere — no HTML injection

/* ---------------- sessions list ---------------- */

async function loadSessions() {
  const res = await fetch('/api/sessions?limit=120');
  if (!res.ok) return;
  const data = await res.json();
  state.sessions = data.sessions;
  state.scanned = data.scanned;
  state.pending = data.pending ?? 0;
  renderSessionList();
  scheduleListRefresh();
}

// Sessions past the server's time budget come back as metadata-only rows;
// poll until they resolve (each pass is cheaper thanks to server caching).
function scheduleListRefresh() {
  if (state.listRefreshTimer) clearTimeout(state.listRefreshTimer);
  if (state.pending > 0) {
    state.listRefreshTimer = setTimeout(loadSessions, 3000);
  }
}

function passesFilter(item) {
  if (item.pending) return true; // status unknown yet — always show, dimmed
  if (state.filter === 'running' && item.status !== 'RUNNING') return false;
  if (state.filter === 'success' && item.status !== 'SUCCESS') return false;
  if (state.filter === 'failed' && !(item.status === 'FAILED' || item.status === 'PARTIAL')) return false;
  if (state.filter === 'problems' && item.problems === 0) return false;
  const q = state.query.trim().toLowerCase();
  if (q && !item.label.toLowerCase().includes(q) && !item.sessionId.toLowerCase().includes(q)) return false;
  return true;
}

function groupLabel(ms) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (ms >= today) return 'Today';
  if (ms >= today - 86400000) return 'Yesterday';
  return 'Earlier';
}

function renderSessionList() {
  const list = $('#session-list');
  list.textContent = '';
  const items = state.sessions.filter(passesFilter);
  const coding = items.filter((i) => i.coding || i.pending);
  const other = items.filter((i) => !i.coding && !i.pending);
  let currentDay = null;
  for (const item of coding) {
    const day = groupLabel(item.lastActivityMs);
    if (day !== currentDay) {
      currentDay = day;
      list.appendChild(el('div', 'day-heading', day));
    }
    list.appendChild(sessionRow(item));
  }
  if (coding.length === 0) {
    list.appendChild(el('div', 'footnote', 'No coding sessions match. Run a coding agent, or check the scanned directories.'));
  }
  // Pure-conversation sessions are not flights — keep them accessible but
  // out of the main list (collapsed by default).
  if (other.length > 0) {
    const head = el('div', 'day-heading other-toggle');
    head.textContent = '▶ Other sessions (' + other.length + ') — not coding';
    head.style.cursor = 'pointer';
    const container = el('div');
    const renderOther = () => {
      container.textContent = '';
      for (const item of other) container.appendChild(sessionRow(item));
    };
    head.addEventListener('click', () => {
      const expanded = container.childElementCount > 0;
      head.textContent = (expanded ? '▶ ' : '▼ ') + 'Other sessions (' + other.length + ') — not coding';
      if (expanded) container.textContent = '';
      else renderOther();
    });
    list.appendChild(head);
    list.appendChild(container);
  }
  $('#scan-info').textContent = state.scanned + ' session files scanned';
}

function sessionRow(item) {
  const row = el('div', 'session-item' + (item.pending ? ' pending-row' : '') + (item.path === state.selectedPath ? ' selected' : ''));
  row.setAttribute('role', 'listitem');
  const line1 = el('div', 'session-line1');
  line1.appendChild(el('span', 'session-label', item.label));
  line1.appendChild(el('span', 'status ' + item.status, item.pending ? '…' : item.status));
  row.appendChild(line1);
  const line2 = el('div', 'session-line2');
  if (item.pending) {
    line2.appendChild(el('span', null, 'analyzing…'));
  } else {
    if (item.project) line2.appendChild(el('span', null, item.project));
    line2.appendChild(el('span', null, fmtDuration(item.durationMs)));
    if (item.problems > 0) {
      line2.appendChild(el('span', 'prob-count', '⚑ ' + item.problems + (item.recovered > 0 ? ' · ' + item.recovered + ' rec' : '')));
    }
    line2.appendChild(el('span', null, item.adapterId));
  }
  row.appendChild(line2);
  row.title = item.pending ? item.path : item.label + ' — ' + (item.project ?? 'unknown project') + ' · ' + item.sessionId;
  row.addEventListener('click', () => selectSession(item.path));
  return row;
}

/* ---------------- session view ---------------- */

async function selectSession(path) {
  state.selectedPath = path;
  renderSessionList();
  const res = await fetch('/api/session?path=' + encodeURIComponent(path));
  if (!res.ok) { alert('Could not load session: ' + (await res.json()).error); return; }
  state.session = await res.json();
  startPolling();
  renderSession();
}

function liveNote(text) {
  const node = $('#live-indicator');
  node.textContent = text;
  node.classList.toggle('hidden', !text);
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (state.session && state.session.running) {
    liveNote(state.session.stale ? '● live — large session, refresh throttled' : '● live — refreshing');
    state.pollTimer = setInterval(async () => {
      if (!state.selectedPath) return;
      const res = await fetch('/api/session?path=' + encodeURIComponent(state.selectedPath));
      if (res.ok) {
        const next = await res.json();
        state.session = next;
        if (next.running) {
          liveNote(next.stale ? '● live — large session, refresh throttled' : '● live — refreshing');
          renderSession();
        } else {
          liveNote(null);
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          renderSession();
          loadSessions();
        }
      }
    }, 3000);
  } else {
    liveNote(null);
  }
}

function renderSession() {
  const { model, running, adapterId, problemEventIds } = state.session;
  $('#empty-state').classList.add('hidden');
  $('#session-view').classList.remove('hidden');

  // overview
  $('#ov-task').textContent = model.task ?? '(no task message recorded)';
  const meta = $('#ov-meta');
  meta.textContent = '';
  const addMeta = (label, value) => {
    const span = el('span');
    span.appendChild(document.createTextNode(label + ' '));
    span.appendChild(el('b', null, value));
    meta.appendChild(span);
  };
  if (model.project) addMeta('Project', model.project);
  addMeta('Duration', fmtDuration(model.durationMs));
  addMeta('Agents', String(model.outcome.agents));
  addMeta('Files changed', String(model.outcome.filesChanged));
  addMeta('Commands', model.outcome.commandsRun + ' run · ' + model.outcome.commandsFailed + ' failed');
  addMeta('Failures', model.outcome.failures + ' · recovered ' + model.outcome.recovered +
    (model.outcome.unresolved > 0 ? ' · unresolved ' + model.outcome.unresolved : ''));
  const badges = $('#ov-badges');
  badges.textContent = '';
  badges.appendChild(el('span', 'badge ' + (running ? 'RUNNING' : model.outcome.status), running ? '● RUNNING' : model.outcome.status));
  if (model.problems.length > 0) {
    badges.appendChild(el('span', 'badge problems', '⚑ ' + model.problems.length + ' problem' + (model.problems.length === 1 ? '' : 's')));
  }
  badges.appendChild(el('span', 'badge', adapterId));
  for (const w of model.warnings.slice(0, 2)) badges.appendChild(el('span', 'badge', w));
  const metaLine = $('#ov-session-id') ?? (() => {
    const node = el('div', 'footnote');
    node.id = 'ov-session-id';
    $('#overview').appendChild(node);
    return node;
  })();
  metaLine.textContent = 'session ' + model.sessionId + (model.project ? ' · ' + model.project : '');

  renderPanel();
}

function setPanel(node) {
  const panel = $('#panel');
  panel.textContent = '';
  panel.appendChild(node);
}

function renderPanel() {
  if (state.tab === 'timeline') renderTimeline();
  else if (state.tab === 'problems') renderProblems();
  else if (state.tab === 'agents') renderAgents();
  else renderFiles();
}

/* ---------------- timeline ---------------- */

function renderTimeline() {
  const { model, problemEventIds } = state.session;
  const mess = state.messOnly;
  const keep = new Set(problemEventIds);
  const wrap = el('div');

  if (mess) {
    const note = el('div', 'mess-hidden-note');
    note.textContent = 'Hiding ' + model.routineCount + ' routine operations — showing only failures, recovery work and retries.';
    wrap.appendChild(note);
  }

  const visible = model.timeline.filter((t) => !mess || keep.has(t.event.id));
  let rendered = 0;
  const CHUNK = 400;
  const sentinel = el('div');
  const renderChunk = () => {
    const slice = visible.slice(rendered, rendered + CHUNK);
    for (const entry of slice) {
      wrap.insertBefore(timelineRow(model, entry, keep), sentinel);
    }
    rendered += slice.length;
    return rendered < visible.length;
  };

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      if (!renderChunk()) io.disconnect();
    }
  });
  io.observe(sentinel);
  wrap.appendChild(sentinel);
  renderChunk();
  setPanel(wrap);
}

function timelineRow(model, entry, keep) {
  const ev = entry.event;
  const isProblem = state.session.model.problems.some((p) => p.eventId === ev.id);
  const isRecovery = state.session.model.problems.some((p) => p.recoverySignal && p.recoverySignal.eventId === ev.id);
  const [glyph, cls] = GLYPHS[ev.type] ?? ['·', 'dim'];
  const row = el('div', 'tl-entry clickable' + (isProblem ? ' problem' : '') + (isRecovery ? ' recovery' : ''));
  row.appendChild(el('span', 'tl-time', fmtOffset(model, (model.startedMs ?? 0) + entry.offsetMs)));
  const glyphSpan = el('span', 'tl-glyph ' + cls, glyph);
  row.appendChild(glyphSpan);
  if (ev.agentId && ev.agentId !== 'main') row.appendChild(el('span', 'tl-agent', ev.agentId));
  const text = el('div', 'tl-text');
  const summary = el('div', 'tl-summary');
  summary.textContent = ev.summary ?? ev.type;
  text.appendChild(summary);

  const details = [];
  if (ev.command) details.push('command: ' + ev.command);
  if (ev.filePath) details.push('file: ' + ev.filePath);
  if (typeof ev.exitCode === 'number') details.push('exit code: ' + ev.exitCode);
  if (ev.durationMs !== null && ev.durationMs !== undefined) details.push('duration: ' + fmtDuration(ev.durationMs));
  if (ev.error) details.push(ev.error);
  if (details.length > 0) {
    const detail = el('div', 'tl-detail');
    for (const d of details) {
      const line = el('div', d === ev.error ? 'err-text' : null, d);
      detail.appendChild(line);
    }
    text.appendChild(detail);
    row.addEventListener('click', () => row.classList.toggle('open'));
  }
  row.appendChild(text);
  return row;
}

/* ---------------- problems ---------------- */

const KIND_LABEL = {
  'test-failure': 'Test failure',
  'build-failure': 'Build failure',
  'command-failure': 'Command failure',
  'error': 'Error',
  'agent-failure': 'Agent failure',
  'timeout': 'Timeout',
  'abort': 'Aborted',
};

function renderProblems() {
  const { model } = state.session;
  const wrap = el('div');
  if (model.problems.length === 0) {
    wrap.appendChild(el('div', 'footnote', 'No problems recorded in this session — ' + model.timeline.length + ' events, all routine.'));
    setPanel(wrap);
    return;
  }
  for (const p of model.problems) {
    const card = el('div', 'problem-card ' + p.status);
    const head = el('div', 'problem-head');
    head.appendChild(el('span', 'problem-title', '#' + p.index + ' ' + (KIND_LABEL[p.kind] ?? p.kind)));
    const categoryLabel = p.category + (p.providerDetail ? ' · ' + p.providerDetail : '');
    head.appendChild(el('span', 'problem-category cat-' + p.category, categoryLabel));
    head.appendChild(el('span', 'problem-time', fmtOffset(model, p.timestampMs)));
    head.appendChild(el('span', 'problem-agent', 'agent ' + p.agentId));
    if (p.attempts > 1) head.appendChild(el('span', 'problem-agent', p.attempts + ' attempts'));
    head.appendChild(el('span', 'problem-status ' + p.status, p.status));
    card.appendChild(head);
    card.appendChild(el('div', 'problem-desc', p.description));
    if (p.errorIdentity) card.appendChild(el('div', 'problem-error', p.errorIdentity));
    const chain = el('div', 'problem-chain');
    const followUps = p.followUps.slice(0, 8);
    for (const step of followUps) {
      const row = el('div', 'chain-step');
      row.appendChild(el('span', 'tl-time', fmtOffset(model, step.timestampMs)));
      row.appendChild(el('span', null, step.description));
      chain.appendChild(row);
    }
    if (p.followUpCount > followUps.length) {
      chain.appendChild(el('div', 'chain-more', '… +' + (p.followUpCount - followUps.length) + ' more follow-up actions'));
    }
    if (p.recoverySignal) {
      const row = el('div', 'chain-step recovery');
      row.appendChild(el('span', 'tl-time', fmtOffset(model, p.recoverySignal.timestampMs)));
      row.appendChild(el('span', null, p.recoverySignal.description));
      chain.appendChild(row);
    } else if (p.status === 'BLOCKED') {
      chain.appendChild(el('div', 'chain-more',
        p.category === 'PROVIDER'
          ? 'the session stopped on this provider issue — no coding recovery applies'
          : 'the session stopped on this environment issue — no coding recovery applies'));
    } else if (p.status === 'UNRESOLVED') {
      chain.appendChild(el('div', 'chain-more', 'no recovery signal before the session ended'));
    } else if (p.status === 'PENDING') {
      chain.appendChild(el('div', 'chain-more', 'no recovery signal yet — session still running'));
    }
    card.appendChild(chain);
    wrap.appendChild(card);
  }
  setPanel(wrap);
}

/* ---------------- agent graph ---------------- */

function renderAgents() {
  const { model } = state.session;
  const wrap = el('div');
  const tree = el('div', 'agent-tree');
  const GLYPH = { SUCCESS: '✓', FAILED: '✕', RUNNING: '●', CANCELLED: '⊘', UNKNOWN: '?' };
  const seen = new Set();

  const renderNode = (agentId, depth) => {
    const agent = model.agents.find((a) => a.agentId === agentId);
    if (!agent || seen.has(agentId)) return;
    seen.add(agentId);
    const node = el('div', 'agent-node');
    const line = el('div', 'agent-line');
    const indent = el('span', null, depth === 0 ? '' : '├─ ');
    line.appendChild(indent);
    line.appendChild(el('span', 'agent-glyph ' + agent.status, GLYPH[agent.status] ?? '?'));
    line.appendChild(el('span', 'agent-id', agent.agentId));
    if (agent.taskSummary) line.appendChild(el('span', 'agent-task', agent.taskSummary));
    if (agent.durationMs !== null) line.appendChild(el('span', 'agent-duration', fmtDuration(agent.durationMs)));
    line.appendChild(el('span', 'agent-count', agent.eventCount + ' events'));
    node.appendChild(line);
    const metaBits = [];
    if (agent.filesTouched.length > 0) metaBits.push('files: ' + agent.filesTouched.join(', '));
    if (agent.errors.length > 0) metaBits.push('errors: ' + agent.errors.join(' · '));
    if (metaBits.length > 0) node.appendChild(el('div', 'agent-meta', metaBits.join('  ·  ')));
    if (agent.children.length > 0) {
      const children = el('div', 'agent-children');
      node.appendChild(children);
      for (const child of agent.children) {
        const childNode = el('div');
        children.appendChild(childNode);
        renderInto(childNode, child, depth + 1);
      }
    }
    return node;
  };
  const renderInto = (container, agentId, depth) => {
    const node = renderNode(agentId, depth);
    if (node) container.appendChild(node);
  };

  if (model.rootAgentId !== null) renderInto(tree, model.rootAgentId, 0);
  for (const agent of model.agents) {
    if (!seen.has(agent.agentId)) renderInto(tree, agent.agentId, 0);
  }
  wrap.appendChild(tree);
  wrap.appendChild(el('div', 'footnote', 'Parent-child edges come from the source logs only — agents whose relationship is not recorded appear separately, marked "?" until evidence arrives.'));
  setPanel(wrap);
}

/* ---------------- files ---------------- */

function renderFiles() {
  const { model } = state.session;
  const wrap = el('div');
  if (model.files.length === 0) {
    wrap.appendChild(el('div', 'footnote', 'No file operations recorded.'));
    setPanel(wrap);
    return;
  }
  const table = el('table', 'files');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['File', 'Created', 'Changed', 'Deleted', 'Reads', 'Agents']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const f of model.files) {
    const tr = el('tr', f.involvedInProblems ? 'problem-file' : null);
    const pathTd = el('td');
    pathTd.appendChild(el('span', 'fpath', f.path));
    if (f.firstTouchedBy && f.firstTouchedBy !== f.lastTouchedBy) {
      pathTd.appendChild(el('div', 'fagents', 'first ' + f.firstTouchedBy + ' → last ' + f.lastTouchedBy));
    }
    tr.appendChild(pathTd);
    tr.appendChild(el('td', null, f.created > 0 ? String(f.created) : ''));
    const changedTd = el('td');
    if (f.changed > 0) changedTd.appendChild(el('span', null, String(f.changed)));
    if (f.additions !== null || f.deletions !== null) {
      changedTd.appendChild(document.createTextNode(' '));
      if (f.additions !== null) changedTd.appendChild(el('span', 'delta-add', '+' + f.additions));
      if (f.deletions !== null) changedTd.appendChild(el('span', 'delta-del', '−' + f.deletions));
    }
    tr.appendChild(changedTd);
    tr.appendChild(el('td', null, f.deleted > 0 ? String(f.deleted) : ''));
    tr.appendChild(el('td', null, f.reads > 0 ? String(f.reads) : ''));
    tr.appendChild(el('td', 'fagents', f.agents.join(', ')));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  const problemFiles = model.files.filter((f) => f.involvedInProblems).length;
  if (problemFiles > 0) {
    wrap.appendChild(el('div', 'footnote', problemFiles + ' file' + (problemFiles === 1 ? '' : 's') + ' were touched while dealing with a failure or recovery (marked on the left).'));
  }
  setPanel(wrap);
}

/* ---------------- wiring ---------------- */

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderSessionList();
  });
});
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderSessionList(); });
$('#refresh').addEventListener('click', () => loadSessions());
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    if (state.session) renderPanel();
  });
});
$('#mess-toggle').addEventListener('change', (e) => {
  state.messOnly = e.target.checked;
  if (state.session && state.tab === 'timeline') renderTimeline();
});

loadSessions();
state.listTimer = setInterval(loadSessions, 10000);
