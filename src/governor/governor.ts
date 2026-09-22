/**
 * POC-04A Safe Governor — deterministic, single-intervention decision logic.
 *
 * QUESTION: can Agent Pigeon safely intervene ONLY when an agent keeps
 * changing implementation without collecting verification evidence?
 *
 * Enabled policies: OBSERVE (silent) and VERIFY_FIRST (one message per debt
 * episode). RETHINK and HUMAN_REVIEW are NOT implemented here — the governor
 * can never emit them.
 *
 * Trigger (all deterministic, content-based):
 *   ≥ 3 materially DISTINCT implementation changes (distinct content
 *   changeFingerprints) AND no build/test/device verification event since
 *   the first of those changes.
 *
 * Never an input: elapsed time, tool-call counts, token usage, repeated
 * identical edits, agent language/claims.
 *
 * Anti-spam: VERIFY_FIRST fires once per debt episode. The episode is keyed
 * by its first content fingerprint; the latch holds until a verification
 * event occurs (any test/build/device run — collecting evidence is what
 * resets the debt), after which a new episode may fire again.
 */

export interface GovernorEvent {
  ts: string;
  toolName: string;
  ok: boolean | null;
  verificationKind: string | null;
  changeFingerprint: string | null;
  fingerprintBasis: string | null;
}

export interface GovernorState {
  /** First content fingerprint of the episode we already warned about. */
  firedEpisodeStart: string | null;
}

export interface GovernorDecision {
  policy: 'SILENT' | 'VERIFY_FIRST';
  message: string | null;
  distinctEdits: number;
  episodeStartHash: string | null;
  state: GovernorState;
}

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isVerification(event: GovernorEvent): boolean {
  return event.toolName === 'Bash' && event.verificationKind !== null && event.verificationKind !== 'other';
}

function isImplementation(event: GovernorEvent): boolean {
  return IMPLEMENTATION_TOOLS.has(event.toolName);
}

export function formatWarning(distinctEdits: number): string {
  return [
    'Agent Pigeon',
    '',
    `${distinctEdits} materially different implementation changes were made without collecting new verification evidence.`,
    '',
    'Verify the current app before another implementation change.',
  ].join('\n');
}

export function computeGovernorDecision(
  events: GovernorEvent[],
  state: GovernorState,
): GovernorDecision {
  // Trailing episode: implementation events after the last verification.
  let lastVerificationIndex = -1;
  events.forEach((event, index) => {
    if (isVerification(event)) lastVerificationIndex = index;
  });

  const episode = events.filter((event, index) => index > lastVerificationIndex && isImplementation(event));
  const contentFingerprints = episode
    .filter((e) => e.fingerprintBasis === 'content' && e.changeFingerprint !== null)
    .map((e) => e.changeFingerprint as string);
  const distinct = new Set(contentFingerprints).size;
  const episodeStartHash = contentFingerprints[0] ?? null;

  // Latch management: an episode other than the latched one (including a
  // fresh episode after verification, or no episode at all) clears the latch.
  const newState: GovernorState = {
    firedEpisodeStart: episodeStartHash === state.firedEpisodeStart ? state.firedEpisodeStart : null,
  };

  if (distinct >= 3 && episodeStartHash !== null && state.firedEpisodeStart !== episodeStartHash) {
    return {
      policy: 'VERIFY_FIRST',
      message: formatWarning(distinct),
      distinctEdits: distinct,
      episodeStartHash,
      state: { firedEpisodeStart: episodeStartHash },
    };
  }

  return { policy: 'SILENT', message: null, distinctEdits: distinct, episodeStartHash, state: newState };
}
