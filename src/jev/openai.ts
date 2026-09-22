/**
 * Optional real Jev implementation against any OpenAI-compatible chat
 * completions endpoint. Fully optional: without JEV_API_KEY the CLI reports
 * "JEV: unavailable" and the deterministic pipeline carries the report.
 */

import type { JevEvaluation, JevOutcome, JevPayload, JevProvider } from './types.js';

const SYSTEM_PROMPT = `You are Jev, a semantic evaluator inside Agent Pigeon, a proof-of-progress governor for coding agents working on a mobile app.

You receive a normalized comparison of two consecutive coding-agent attempts: build status, failed-test counts, normalized crash and screen signatures, and deterministic signals. You never see source code and must judge only from this normalized evidence. Activity is not progress: more code changes, more tool calls, or a different patch mean nothing by themselves.

Answer three INDEPENDENT questions, each with a probability between 0 and 1:
- progress: Did the latest attempt produce meaningful measurable progress toward fixing the application?
- evidence_gain: Did the latest attempt produce useful new runtime evidence?
- rethink_needed: Should the coding agent reconsider its current hypothesis before making another implementation change?

Reply with STRICT JSON only, no prose:
{"progress": <0..1>, "evidence_gain": <0..1>, "rethink_needed": <0..1>}`;

export interface OpenAiCompatibleJevOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export class OpenAiCompatibleJev implements JevProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly options: OpenAiCompatibleJevOptions = {}) {}

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? process.env.JEV_API_KEY;
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async evaluate(payload: JevPayload): Promise<JevOutcome> {
    const startedAt = performance.now();
    try {
      const apiKey = this.apiKey;
      if (apiKey === undefined || apiKey.length === 0) {
        return { available: false, reason: 'JEV: unavailable (no API key configured)' };
      }

      const model = this.options.model ?? process.env.JEV_MODEL ?? 'gpt-4o-mini';
      const baseUrl = (
        this.options.baseUrl ??
        process.env.JEV_BASE_URL ??
        'https://api.openai.com/v1'
      ).replace(/\/+$/u, '');
      const timeoutMs = this.options.timeoutMs ?? 30_000;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(payload) },
            ],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return {
          available: false,
          reason: `JEV: unavailable (provider returned HTTP ${response.status})`,
        };
      }

      const body = (await response.json()) as ChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      if (content === undefined) {
        return { available: false, reason: 'JEV: unavailable (empty provider response)' };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { available: false, reason: 'JEV: unavailable (provider returned non-JSON content)' };
      }

      const record = (parsed ?? {}) as Record<string, unknown>;
      const progress = clamp01(record['progress']);
      const evidenceGain = clamp01(record['evidence_gain']);
      const rethinkNeeded = clamp01(record['rethink_needed']);
      if (progress === null || evidenceGain === null || rethinkNeeded === null) {
        return { available: false, reason: 'JEV: unavailable (missing or malformed probabilities)' };
      }

      const tokens =
        body.usage === undefined
          ? null
          : {
              input: body.usage.prompt_tokens ?? 0,
              output: body.usage.completion_tokens ?? 0,
            };

      const evaluation: JevEvaluation = {
        progress,
        evidenceGain,
        rethinkNeeded,
        provider: this.name,
        model,
        latencyMs: performance.now() - startedAt,
        tokens,
      };
      return { available: true, evaluation };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `JEV: unavailable (${message})` };
    }
  }
}
