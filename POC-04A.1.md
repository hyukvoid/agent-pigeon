# POC-04A.1 — Live Delivery & Concurrency Gate — Findings

- Date: 2026-09-22
- Branch: `poc/04a1-live-delivery` (from POC-04A final commit `683a55b`)
- Final regression: **65/65 tests pass** (was 63; +2 net after rewriting the delivery scenarios for the batch path)
- Scope: delivery timing (PostToolBatch), concurrency safety (secret + state), race removal. RETHINK / Jev / HUMAN_REVIEW remain unimplemented.

## 1. Verdict: PASS

> VERIFY_FIRST가 다음 "사람 프롬프트"가 아니라 **다음 모델 호출 전**에 도달할 수 있는가? 그리고 동시성·경쟁 상태에서도 한 번-임-에피소드 의미론이 유지되는가?

**Yes (locally proven).** VERIFY_FIRST is now delivered through a **PostToolBatch** hook that synchronously performs read → evaluate → latch → output in a single process before the next model call, with no dependency on a racing worker or decision.json. Parallel first-use secret creation converges on one secret; parallel events do not corrupt state; all failures fail open. Live-agent effect remains deferred (quota).

## 2. Delivery point change (§1)

- **Removed**: `hooks/deliver-verify-first.mjs` (UserPromptSubmit primary delivery) — deleted, including the deployed copy. UserPromptSubmit fired only when the human typed again, which is too late inside an agentic tool loop.
- **New primary**: `PostToolBatch` — confirmed in the official hooks documentation of the installed version channel: *"After a full batch of parallel tool calls resolves, before the next model call"*, no matcher needed. (A string-level check of the packed local binary was inconclusive — packed executable — so the event is validated via official docs plus local contract tests; real firing is part of the deferred live validation.)
- Output: `hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: <factual message> }, suppressOutput: true`. Never `decision:"block"`; nothing is blocked.

## 3. Architecture (§2–§3)

```
PostToolUse (async observer)     → append ONE sanitized event → return immediately
PostToolBatch (sync delivery)    → ONE process:
     read local events (session-filtered) →
     computeGovernorDecision (deterministic, unchanged from POC-04A) →
     anti-spam latch (atomic state replace under short exclusive lock) →
     additionalContext  OR  silent
```

- **Race removed**: no worker/decision.json dependency for correctness. The batch hook is the single reader-evaluator-latcher. `governor:process` + `decision.json` remain only as optional offline debugging tools.
- The batch hook waits for nothing external: no network, no Jev, no agent-device, no transcript scan, no git.
- Known consistency trade-off (documented, accepted): with an `async` PostToolUse observer, events from the *just-finished* batch may land after PostToolBatch reads — the warning then arrives one batch later instead of being lost (the latch guarantees once-per-episode whenever it fires). Registering the observer synchronously restores same-batch delivery if ever needed.

## 4. Race-safe secret creation (§4)

First-use secret creation now uses exclusive create (`openSync('wx')`):
- concurrent first-use hooks race; exactly one wins the create,
- losers catch `EEXIST` and read the winner's secret, polling briefly (≤2 s) in case the winner has not flushed yet,
- every process converges on the SAME secret.

**Test F (12 concurrent hooks on a first-ever run)**: all 12 exit 0; exactly one valid 64-hex secret; all 12 events carry 32-hex content fingerprints reproducible with that one secret (verified against the TS implementation); the episode then fires exactly one VERIFY_FIRST mentioning all 12. No raw secret output anywhere.

## 5. State write safety (§5)

- Latch persistence (`governor-state.json`) uses **atomic replace**: temp file + rename (crash mid-write leaves the old or the new file, never a partial one).
- Concurrent batch invocations serialize through a short exclusive lock file (`'wx'`, ≤1.5 s wait). Lock timeout = **fail open**: deliver nothing rather than block the model loop.
- Corrupt/missing state = **fail open**: treated as unlatched; the hook still exits 0 and only ever emits well-formed JSON (tested with a deliberately corrupted file, test G).

## 6. Message (§6)

Unchanged, factual and short:

```
Agent Pigeon

3 materially different implementation changes were made without collecting new verification evidence.

Verify the current app before another implementation change.
```

No "stuck", "wrong approach", "rethink", or "failed strategy" wording anywhere in the delivery path (asserted by exact-message tests).

## 7. Tests A–H (all green; full suite 65/65)

| # | Scenario | Result |
| --- | --- | --- |
| A | edit A/B/C → PostToolBatch | exactly one additionalContext VERIFY_FIRST (`PostToolBatch` event name asserted), next batch silent |
| B | edit A/B, test, edit C | silent |
| C | warning, then next batch without verification | silent |
| D | warning → test → new A/B/C episode | warns once again |
| E | parallel Edit A/B/C | 3 valid JSONL events, one episode, one warning, next batch silent |
| F | 12 concurrent hooks, first-ever run | one secret, all fingerprints consistent under it, one warning (mentions 12) |
| G | corrupt/missing state | fail open, exit 0, no broken output |
| H | productive fix/test sequence | silent |

Unit tests retained: time/tool-count/repeated-edit non-triggers, failed-test-runs-count-as-verification, path-basis non-distinctness.

## 8. PostToolBatch delivery latency (§8) — real wall time, honest

This path is synchronous before the next model call. Measured with the real compiled hook (Windows, Node 24.19, isolated home, 3-edit episode prepared):

| Phase | p50 | p95 | max | min |
| --- | --- | --- | --- | --- |
| Cold firing run (evaluates + latches + emits) | — | — | **93.7 ms** | — |
| Warm latched runs (n=60) | **93.1 ms** | **99.0 ms** | 110.1 ms | 86.2 ms |

Attribution: bare `node -e ""` startup on this machine is ~90 ms p50, so the entire read→evaluate→latch decision work is ~1–3 ms; cost is Node process startup. **Binary rewrite recommendation: NOT triggered** — a one-shot ~93 ms observer cost after a full parallel tool batch (which itself typically runs for seconds) is not materially problematic, and `PostToolBatch` frequency is per-batch, not per-tool. If it ever matters, the same contract can move to a compiled binary without design change.

## 9. LIVE AGENT EFFECT

**DEFERRED_BY_ACCOUNT_ACCESS** (quota). Local contract validated (event semantics per official docs, JSON output shape, anti-spam, concurrency). No claim is made that Claude's behavior improved; real behavioral validation requires a live session.

## 10. Unresolved risks

1. `async` observer + sync PostToolBatch can delay a warning by one batch (eventually-delivered, never lost). Sync observer registration removes the lag at the cost of ~100 ms per tool call.
2. additionalContext support on PostToolBatch is per the documented decision-model fields; per-event honor behavior is confirmed only in live validation (deferred).
3. Stale `governor-batch.lock` from a hard-killed process self-heals via the 1.5 s lock timeout (one batch may deliver nothing), not via state corruption.
4. Git backup risk from POC-04A PART B remains open (no remote configurable without verified ownership).

## Commits

- `feat: race-safe per-install secret and atomic state writes`
- `feat: PostToolBatch as primary VERIFY_FIRST delivery (single-process read-evaluate-latch-output)`
- `test: live delivery scenarios A–H with concurrency and fail-open coverage`
- `perf: benchmark PostToolBatch delivery path (p50/p95/max)`
- `docs: record POC-04A.1 findings`

**STOP. RETHINK not implemented. Awaiting user review.**
