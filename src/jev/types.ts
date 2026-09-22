/**
 * Jev provider interface.
 *
 * Jev is a semantic evaluator and nothing more. Its input is a NORMALIZED
 * attempt comparison (never source code); its output is three independent
 * probabilities. If no provider is configured, the deterministic report is
 * still complete (POC-00 §7).
 */

export interface NormalizedAttemptView {
  attemptId: string;
  build: string | null;
  testsFailed: number | null;
  crashSignature: string | null;
  screenSignature: string | null;
  codeChanged: boolean;
  changedFilesCount: number | null;
}

export interface JevPayload {
  schema: 'agent-pigeon/jev-comparison@0';
  previous: NormalizedAttemptView;
  current: NormalizedAttemptView;
  signals: {
    buildChanged: boolean | null;
    failedTestsDelta: number | null;
    crashChanged: boolean | null;
    screenChanged: boolean | null;
    codeNovelty: boolean | null;
    sameCrashStreak: number;
    sameScreenStreak: number;
    verificationDebt: string;
  };
  questions: {
    progress: string;
    evidenceGain: string;
    rethinkNeeded: string;
  };
}

export interface JevAssessment {
  progress: number;
  evidenceGain: number;
  rethinkNeeded: number;
}

export interface JevEvaluation extends JevAssessment {
  provider: string;
  model: string | null;
  latencyMs: number;
  tokens: { input: number; output: number } | null;
}

export type JevOutcome =
  | { available: true; evaluation: JevEvaluation }
  | { available: false; reason: string };

export interface JevProvider {
  readonly name: string;
  isConfigured(): boolean;
  evaluate(payload: JevPayload): Promise<JevOutcome>;
}

export const JEV_QUESTIONS: JevPayload['questions'] = {
  progress:
    'Did the latest attempt produce meaningful measurable progress toward fixing the application?',
  evidenceGain: 'Did the latest attempt produce useful new runtime evidence?',
  rethinkNeeded:
    'Should the coding agent reconsider its current hypothesis before making another implementation change?',
};
