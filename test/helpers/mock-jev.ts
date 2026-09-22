import type { JevEvaluation, JevOutcome, JevPayload, JevProvider } from '../../src/jev/types.js';

/**
 * Deterministic mock Jev used to exercise the provider interface and report
 * rendering without any network access. Mapping is intentionally simple and
 * stable so tests never flake.
 */
export class MockJev implements JevProvider {
  readonly name = 'mock';
  callCount = 0;
  lastPayload: JevPayload | null = null;

  isConfigured(): boolean {
    return true;
  }

  async evaluate(payload: JevPayload): Promise<JevOutcome> {
    this.callCount++;
    this.lastPayload = payload;
    const s = payload.signals;
    const progressed =
      (s.failedTestsDelta !== null && s.failedTestsDelta < 0) ||
      s.crashChanged === true ||
      s.screenChanged === true;

    const evaluation: JevEvaluation = {
      progress: progressed ? 0.88 : 0.12,
      evidenceGain: progressed ? 0.9 : 0.08,
      rethinkNeeded: !progressed && s.codeNovelty === true ? 0.91 : 0.05,
      provider: this.name,
      model: 'mock-evaluator',
      latencyMs: 0.5,
      tokens: { input: 412, output: 38 },
    };
    return { available: true, evaluation };
  }
}
