/**
 * Agent Pigeon — `share` (v0.1 MVP): deterministic SVG generation.
 *
 *   agent-pigeon share flight [session] [--output <path>]
 *   agent-pigeon share compare <A> <B> [--output <path>]
 *
 * Produces privacy-safe SVG cards from the same FlightFacts used by flight
 * and replay. Deterministic: the same session always produces the same SVG.
 * No network fonts, no screenshots, no browser — just string building.
 *
 * Privacy: SVG output contains only aggregate counts, short session IDs, and
 * display-safe file names (last segments). No commands, prompts, source
 * code, absolute paths, or raw transcript content.
 */

import type { FlightFacts } from './flight.js';



import type { SessionAnalysis } from './replay/corpus.js';




// --- palette (system-safe, no external fonts) ---
const BG = '#1a1a2e';
const FG = '#e0e0e0';
const DIM = '#8888aa';
const ACCENT = '#82aaff';
const GOOD = '#7ee787';
const BAD = '#f97583';
const NEUTRAL = '#c8c8d0';
const BAR_BG = '#2a2a4a';

const CARD_W = 560;

function esc(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function textEl(x: number, y: number, content: string, size = 13, fill = FG, weight = 'normal'): string {
  return `<text x="${x}" y="${y}" font-family="monospace" font-size="${size}" fill="${fill}" font-weight="${weight}">${esc(content)}</text>`;
}

function barEl(x: number, y: number, w: number, value: number, max: number, fill: string): string {
  const h = 14;
  if (value === 0) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${BAR_BG}"/><text x="${x + 4}" y="${y + 11}" font-family="monospace" font-size="10" fill="${DIM}">0</text><text x="${x + w + 6}" y="${y + 11}" font-family="monospace" font-size="11" fill="${FG}">${value}</text>`;
  }
  const filled = Math.max(2, Math.round((value / max) * w));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${BAR_BG}"/><rect x="${x}" y="${y}" width="${filled}" height="${h}" rx="2" fill="${fill}"/><text x="${x + w + 6}" y="${y + 11}" font-family="monospace" font-size="11" fill="${FG}">${value}</text>`;
}

// --- Flight card ---

export function renderFlightSvg(facts: FlightFacts): string {
  const W = CARD_W;
  const H = 300;
  const hasReads = facts.reads !== null;
  const max = Math.max(facts.reads ?? 0, facts.edits, facts.recognizedVerificationRuns, 1);

  const bars: string[] = [];
  let y = 90;
  const barX = 24;
  const barW = W - 24 - 24 - 50;

  if (hasReads) {
    bars.push(textEl(barX, y + 11, 'READ', 11, DIM));
    bars.push(barEl(barX + 50, y, barW, facts.reads ?? 0, max, NEUTRAL));
    y += 26;
  }
  bars.push(textEl(barX, y + 11, 'EDIT', 11, DIM));
  bars.push(barEl(barX + 50, y, barW, facts.edits, max, ACCENT));
  y += 26;
  bars.push(textEl(barX, y + 11, 'VERIFY', 11, DIM));
  bars.push(barEl(barX + 50, y, barW, facts.recognizedVerificationRuns, max, GOOD));
  y += 26;
  if (facts.debuggingLoop !== null) {
    bars.push(textEl(barX, y + 11, 'FAIL→PASS', 11, DIM));
    bars.push(barEl(barX + 60, y, barW, facts.debuggingLoop.length, max, BAD));
    y += 26;
  }

  let bottomY = y + 14;
  if (facts.mostTouched !== null) {
    bars.push(textEl(24, bottomY, '🔥 Most touched', 11, DIM));
    bars.push(textEl(140, bottomY, facts.mostTouched.path, 11, NEUTRAL));
    bottomY += 18;
  }
  if (facts.longestUnverifiedStreak !== null && facts.longestUnverifiedStreak.changes >= 3) {
    bars.push(textEl(24, bottomY, '⏱ Longest coding streak', 11, DIM));
    bars.push(textEl(170, bottomY, `${facts.longestUnverifiedStreak.changes} changes without recognized verification`, 11, BAD));
    bottomY += 18;
  }

  bars.push(textEl(24, H - 14, 'Local · Read-only · Nothing uploaded', 10, DIM));

  const title = `🐦 Agent Pigeon — Flight Report`;
  const sub = `${facts.sourceLabel} · session ${facts.sessionId8} · span ${facts.duration}`;

  const footerBar = `Agent Pigeon · proof-of-progress for coding agents`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" rx="8" fill="${BG}"/>`,
    textEl(24, 32, title, 15, ACCENT, 'bold'),
    textEl(24, 52, sub, 11, DIM),
    ...bars,
    textEl(24, H - 32, footerBar, 11, DIM),
    `</svg>`,
  ].join('\n');
}

// --- Compare card ---

export function renderCompareSvg(fa: FlightFacts, fb: FlightFacts): string {
  const W = CARD_W;
  const H = 320;
  const colA = 200;
  const colB = 380;
  const max = Math.max(fa.edits, fb.edits, fa.recognizedVerificationRuns, fb.recognizedVerificationRuns, 1);

  const bars: string[] = [];
  let y = 80;

  const barRow = (label: string, a: number, b: number, fill: string): void => {
    bars.push(textEl(24, y + 11, label, 11, DIM));
    bars.push(barEl(colA - 20, y, 120, a, max, fill));
    bars.push(textEl(colA - 20 + 124, y + 11, String(a), 11, FG));
    bars.push(barEl(colB - 20, y, 120, b, max, fill));
    bars.push(textEl(colB - 20 + 124, y + 11, String(b), 11, FG));
    y += 24;
  };

  bars.push(textEl(24, y, `${fa.sourceLabel} ${fa.sessionId8}`, 11, ACCENT));
  bars.push(textEl(colB - 20, y, `${fb.sourceLabel} ${fb.sessionId8}`, 11, ACCENT));
  y += 20;

  barRow('EDIT', fa.edits, fb.edits, ACCENT);
  barRow('VERIFY', fa.recognizedVerificationRuns, fb.recognizedVerificationRuns, GOOD);

  // Streak
  const streakA = fa.longestUnverifiedStreak;
  const streakB = fb.longestUnverifiedStreak;
  bars.push(textEl(24, y + 11, 'Longest unverified', 11, DIM));
  bars.push(textEl(colA - 20, y + 11, streakA ? `${streakA.changes} ch / ${streakA.attempts} att` : '—', 11, FG));
  bars.push(textEl(colB - 20, y + 11, streakB ? `${streakB.changes} ch / ${streakB.attempts} att` : '—', 11, FG));
  y += 22;

  // Most touched
  bars.push(textEl(24, y + 11, 'Most touched', 11, DIM));
  bars.push(textEl(colA - 20, y + 11, fa.mostTouched ? fa.mostTouched.path : '—', 11, NEUTRAL));
  bars.push(textEl(colB - 20, y + 11, fb.mostTouched ? fb.mostTouched.path : '—', 11, NEUTRAL));

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" rx="8" fill="${BG}"/>`,
    textEl(24, 32, '🐦 Agent Pigeon — Session Compare', 14, ACCENT, 'bold'),
    ...bars,
    `</svg>`,
  ].join('\n');
}
