/**
 * Attention ranking — the v0.3 radar's brain.
 *
 * The radar answers one question in three seconds: "which of my coding
 * agents needs attention right now?" Ranking is by attention, not activity:
 * blocked first, then failed, then recovery-in-progress, then everything
 * that is merely alive.
 *
 * State honesty rules (see adapter capability matrix):
 *  - RUNNING is only used when the caller has evidence the file is live.
 *  - A session without a completion record is "idle", never "DONE".
 *  - Recovery language applies only to coding failures; provider and
 *    environment failures are BLOCKED, never "recovering".
 */

import type { Problem, ProblemCategory, SessionModel } from './types.js';

export type AttentionTier = 1 | 2 | 3 | 4 | 5 | 6;

export const ATTENTION_TIERS: Record<AttentionTier, string> = {
  1: 'BLOCKED',
  2: 'FAILED',
  3: 'RECOVERY IN PROGRESS',
  4: 'RUNNING · HAD PROBLEMS',
  5: 'RUNNING',
  6: 'IDLE',
};

export interface AttentionHeadline {
  category: ProblemCategory | null;
  /** Category refinement for PROVIDER problems (AUTH/QUOTA/RATE_LIMIT). */
  providerDetail: string | null;
  summary: string;
  recoveryState: string;
}

export interface AttentionAssessment {
  tier: AttentionTier;
  label: string;
  headline: AttentionHeadline | null;
}

function worstProblem(problems: Problem[]): Problem | null {
  // BLOCKED first, then by recency (problems are already chronological).
  const weight = (p: Problem): number =>
    p.status === 'BLOCKED' ? 3 : p.status === 'UNRESOLVED' ? 2 : p.status === 'PENDING' || p.status === 'POSSIBLY_RECOVERED' ? 1 : 0;
  let best: Problem | null = null;
  for (const p of problems) {
    if (p.status === 'RECOVERED') continue;
    if (best === null || weight(p) > weight(best)) best = p;
  }
  return best;
}

function headlineFor(problem: Problem | null, running: boolean): AttentionHeadline | null {
  if (problem === null) return null;
  let recoveryState: string;
  switch (problem.status) {
    case 'BLOCKED': recoveryState = 'BLOCKED'; break;
    case 'UNRESOLVED': recoveryState = 'UNRESOLVED'; break;
    case 'PENDING':
    case 'POSSIBLY_RECOVERED':
      recoveryState = running ? 'RECOVERY IN PROGRESS' : problem.status;
      break;
    case 'RECOVERED': recoveryState = 'RECOVERED'; break;
    default: recoveryState = problem.status;
  }
  return {
    category: problem.category,
    providerDetail: problem.providerDetail,
    summary: problem.description,
    recoveryState,
  };
}

/**
 * Assess one session. `running` must come from file evidence (recent mtime
 * on an unfinished log) — the radar never guesses liveness.
 */
export function assessAttention(model: SessionModel, running: boolean): AttentionAssessment {
  const problems = model.problems;
  const providerOrEnvironment = problems.some(
    (p) => p.category === 'PROVIDER' || p.category === 'ENVIRONMENT',
  );

  let tier: AttentionTier;
  let headline: AttentionHeadline | null = null;

  if (problems.some((p) => p.status === 'BLOCKED') || (running && providerOrEnvironment)) {
    tier = 1;
    const blocked = problems.find((p) => p.status === 'BLOCKED')
      ?? problems.find((p) => p.category === 'PROVIDER' || p.category === 'ENVIRONMENT')
      ?? null;
    headline = headlineFor(blocked, running);
    if (headline !== null) headline.recoveryState = 'BLOCKED';
  } else if (problems.some((p) => p.status === 'UNRESOLVED')) {
    tier = 2;
    headline = headlineFor(problems.find((p) => p.status === 'UNRESOLVED') ?? null, running);
  } else if (running && problems.some((p) => p.status === 'PENDING' || p.status === 'POSSIBLY_RECOVERED')) {
    tier = 3;
    const active = problems.find((p) => p.status === 'PENDING' || p.status === 'POSSIBLY_RECOVERED') ?? null;
    headline = headlineFor(active, running);
    if (headline !== null) headline.recoveryState = 'RECOVERY IN PROGRESS';
  } else if (running && problems.length > 0) {
    tier = 4;
  } else if (running) {
    tier = 5;
  } else {
    tier = 6;
  }

  return { tier, label: ATTENTION_TIERS[tier], headline };
}

/**
 * Sort key for radar rows: tier first, then most-recent activity first.
 * `lastActivityMs` and `pending` come from the session list item.
 */
export function attentionSortKey(
  tier: AttentionTier,
  lastActivityMs: number,
  nowMs: number,
): number {
  // Composite: tier dominates; within a tier, recency decays the key.
  return tier * 1e15 + Math.max(0, nowMs - lastActivityMs);
}
