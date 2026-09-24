# POC-00 — Mobile Proof-of-Progress Core — Findings

- Date: 2026-09-22
- Branch: `poc/00-proof-of-progress` (bootstrap on `main`: `chore: initialize Agent Pigeon`)
- Node v24.19.0, TypeScript 5.9.3, zero runtime dependencies
- Environment: Windows 11, no Android device/emulator attached, no Jev API key configured

## 1. Verdict

**PASS** — with one condition: Jev was validated at the interface level only (mock + error path), not against a live provider, because no API key exists in this environment. Every deterministic criterion was validated for real.

The one question POC-00 set out to answer:

> Can we reliably judge whether real mobile runtime evidence improved, stayed the same, or was never verified — across coding-agent attempts?

Answer: **yes, from normalized local evidence alone.** The three mandatory scenarios are separated by pure deterministic computation, and the human verdicts read correctly.

## 2. Deliverables map (§16)

| Deliverable | Location |
| --- | --- |
| Evidence schema | `src/core/types.ts` (`AttemptEvidence` + hand-rolled validator) |
| Deterministic signal calculator | `src/core/signals.ts` |
| Gain / progress / dead-end / policy | `src/core/evaluate.ts` |
| agent-device output parser + fixtures | `src/agent-device/parse.ts`, `fixtures/agent-device/` |
| 3 mandatory fixtures | `fixtures/scenarios/fixture-{a,b,c}.json` |
| Jev provider interface | `src/jev/types.ts`, `src/jev/payload.ts` (normalized payload + sanitizer) |
| Optional real Jev implementation | `src/jev/openai.ts` (`OpenAiCompatibleJev`, env: `JEV_API_KEY`, `JEV_BASE_URL`, `JEV_MODEL`) |
| CLI POC output | `src/cli.ts` → `npm run poc:00 [-- --scenario a|b|c|all] [--print-payload] [--json] [--no-jev]` |
| Minimal tests | `test/*.test.ts` — 23 tests, all passing |
| Findings | this file |

Not built (per STOP rule §0/§17): hooks, daemon, dashboard, notifications, PigeonHub, auto-intervention. Policy is computed and printed only.

## 3. Actual CLI output (`npm run poc:00`)

### Scenario A — Productive progress

```
Scenario: Productive progress

Attempts                  2
Changed implementations   2

Runtime proof
Tests                     18 → 9
Crash                     NullPointerException:LoginVie… → IllegalStateException:OtpView…
Screen                    Login → OTP

Verification debt         LOW
Evidence gain             HIGH
Runtime progress          HIGH

Jev
Progress                  JEV: unavailable (no API key configured)

Policy                    CONTINUE
Deterministic eval        917 µs

Verdict

✓ Productive progress — runtime evidence improved.
```

### Scenario B — Different code, same app

```
Scenario: Different code, same app

Attempts                  3
Changed implementations   3

Runtime proof
Tests                     8 → 8 → 8
Crash                     NullPointerException:LoginVie… → NullPointerException:LoginVie… → NullPointerException:LoginVie…
Screen                    Login → Login → Login

Verification debt         LOW
Evidence gain             LOW
Runtime progress          LOW
Dead-end candidate        YES

Jev
Progress                  JEV: unavailable (no API key configured)

Policy                    RETHINK

Verdict

⚠ Different code. Same app.
```

### Scenario C — Verification debt

```
Scenario: Verification debt

Attempts                  4
Changed implementations   4

Runtime proof
Tests                     ? → ? → ? → ?
Crash                     (none) → (none) → (none) → (none)
Screen                    (none) → (none) → (none) → (none)

Verification debt         HIGH
Evidence gain             LOW
Runtime progress          LOW

Jev
Progress                  JEV: unavailable (no API key configured)

Policy                    VERIFY_FIRST
Deterministic eval        81 µs

Verdict

⏸ 4 implementation attempts were made without collecting new runtime evidence.
```

## 4. Success criteria (§14)

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Productive progress vs same-app dead-end distinguished | **PASS** | A → gain HIGH / CONTINUE; B → dead-end YES / RETHINK; enforced by `test/evaluate.test.ts` |
| 2 | Verification debt detected without Jev | **PASS** | C → streak 4 → HIGH → VERIFY_FIRST with the §9 message, pure local computation |
| 3 | Same fixture → identical local signals | **PASS** | `test/determinism.test.ts` runs the full pipeline twice per fixture and compares serialized output; signals are pure functions of the fixture |
| 4 | CLI runs normally without Jev | **PASS** | output above; `JEV: unavailable (no API key configured)` and the report is complete |
| 5 | With Jev, normalized evidence → semantic probabilities | **PARTIAL (interface verified)** | Provider contract exercised via deterministic mock (`test/report.test.ts`) and the error path against a real HTTP call (below); no live key available, so no live probability observed |
| 6 | "Different code. Same app." is human-readable | **PASS** | Scenario B verdict block; one line, no code context needed |
| 7 | No new ADB/device framework built | **PASS** | Only a ~100-line parser of recorded agent-device output exists; agent-device itself is untouched, not forked, not wrapped |

## 5. FAIL / STOP criteria (§15) — none hit

- Raw source code was never needed: crash/screen signatures + counts decided every case.
- Runtime evidence was the deciding input everywhere except scenario C, where its *absence* is exactly the signal.
- Usable evidence was derived from real agent-device command output shapes (parser tests prove fixture JSON == parsed recordings).
- Productive vs dead-end fixtures separate stably and deterministically.
- The product has clear value without Jev: scenarios A/B/C already produce verdict + policy.

## 6. Measurements (§12)

### Deterministic evaluation latency

- Steady state (100,000 iterations × 3 scenarios = 300,000 runs of `evaluateScenario` + `buildJevPayload`): **≈ 2 µs per scenario evaluation** (600.6 ms total).
- In-process cold numbers printed by the CLI (first JIT-warm run per scenario): 917 µs (A), 213 µs (B), 81 µs (C).
- Conclusion: the deterministic path is effectively free; latency work is unnecessary at POC scale.

### Jev latency / tokens

- Not exercised live — no `JEV_API_KEY` in this environment.
- Error path verified for real: `JEV_API_KEY=… JEV_BASE_URL=http://127.0.0.1:9/v1 node dist/src/cli.js --scenario c` → provider call attempted, failed fast with `JEV: unavailable (fetch failed)`, and the deterministic report + policy were unaffected.
- Token accounting is implemented (reads `usage.prompt_tokens` / `completion_tokens` from the response) but unverified live. Payload for scenario B is ~430 tokens as JSON (estimate; not a measured API count).

### Jev payload actually constructed (scenario B, `--print-payload`)

```json
{
  "schema": "agent-pigeon/jev-comparison@0",
  "previous": {
    "attemptId": "b2", "build": "pass", "testsFailed": 8,
    "crashSignature": "NullPointerException:LoginViewModel#onSubmit",
    "screenSignature": "Login",
    "codeChanged": true, "changedFilesCount": 3
  },
  "current": {
    "attemptId": "b3", "build": "pass", "testsFailed": 8,
    "crashSignature": "NullPointerException:LoginViewModel#onSubmit",
    "screenSignature": "Login",
    "codeChanged": true, "changedFilesCount": 1
  },
  "signals": {
    "buildChanged": false, "failedTestsDelta": 0, "crashChanged": false,
    "screenChanged": false, "codeNovelty": true,
    "sameCrashStreak": 3, "sameScreenStreak": 3, "verificationDebt": "LOW"
  },
  "questions": {
    "progress": "Did the latest attempt produce meaningful measurable progress toward fixing the application?",
    "evidenceGain": "Did the latest attempt produce useful new runtime evidence?",
    "rethinkNeeded": "Should the coding agent reconsider its current hypothesis before making another implementation change?"
  }
}
```

Privacy checks on this payload are enforced by `payloadSafetyIssues()` + tests: no source code, no absolute paths, no keys/credentials, free-text capped at 120 chars. Local deterministic verdicts are deliberately **not** sent, so Jev stays an independent judge.

## 7. agent-device findings (§8)

- Real package: **callstack/agent-device v0.21.8** (`npm view agent-device`). The CLI runs on this machine without any device (`npx agent-device --help` works; `agent-device devices` returns nothing with no device attached).
- Surfaces relevant to evidence, confirmed from its own help output:
  - `snapshot [--diff] [-i] [--depth] [--raw]` — accessibility-tree snapshot; `--diff` compares against the previous session baseline → this is the natural **screenSignature / screenChanged** source.
  - `logs path | start | stop | clear [--restart] | mark` — session app-log streaming → natural **crashSignature** source (parse the FATAL EXCEPTION block).
  - `screenshot`, `record`, `network`, `perf`, `trace` — extra evidence channels, unused in POC-00.
  - `is` / `get` / `find` / `wait text "…"` — expectation verification, candidate for `verification.performed` semantics in POC-01.
- POC-00 approach: recordings (`fixtures/agent-device/attempt-a*.txt`) use the real command shapes; `src/agent-device/parse.ts` extracts `(crashSignature, screenSignature, verificationPerformed)` and tests prove the parsed output **equals** the runtime fields stored in `fixture-a.json`. The parser/evaluator loop therefore runs without a device, as required.
- Gaps: all recorded bodies are **representative, not live captures**; `logs` is a streaming/path API so POC-01 must define the per-attempt capture window (`logs start` → interact → `logs stop` → read file); crash-signature normalization currently handles AndroidRuntime-style Java/Kotlin traces only.

## 8. Schema decisions & deviations

1. **Added `code.changeSetHash`** (not in §3): §5 CASE B and §9 Fixture B require "different patch: yes" to be deterministic. `changedFilesCount` alone cannot distinguish a new patch from a re-commit. `changeSetHash` = hash of the sorted changed-file path list — no content travels anywhere.
2. **Added internal signals `codeNovelty` and `sameTestsStreak`** (not in §4's list): required for dead-end detection; the §4 signals are all present and computed as specified.
3. **Null semantics**: a trailing null runtime value yields streak 0 — "we never looked" must never read as "nothing changed". This is what keeps scenario C from being misclassified as a dead end.
4. Thresholds (documented, tunable): verification debt HIGH at ≥3 consecutive unverified code-changing attempts (C has 4); dead-end at ≥3 attempts all novel with frozen crash/screen/tests.

## 9. Issues found during the POC

1. **Windows/Node runner quirk**: `node --test <dir>` fails here (treated as a module); the test script uses the runner's glob form `"dist/test/**/*.test.js"` instead.
2. **Crash-line regex bug caught by tests**: the first version required a dot-delimited prefix before `Exception`, so `java.lang.NullPointerException` never matched (the class name runs into `Exception` without a dot). Rewrote the token extraction; logcat-prefixed (`at …`) frames are now handled too.
3. **Fixture path resolution** had to be relative to the compiled module (`dist/src/…`), not the cwd.
4. **`gh` CLI is not installed** on this machine, so the GitHub remote (`hyukvoid/agent-pigeon`, private) could **not** be created automatically. The repo is local-only; to publish: create the private repo on GitHub, then `git remote add origin … && git push -u origin main poc/00-proof-of-progress`.
5. A pre-POC skeleton from an earlier session (a broader transcript-funnel design) was found in the working tree; it is preserved untouched on branch `archive/pre-poc-skeleton` and POC-00 was implemented fresh to the spec's schema.

## 10. POC-01 recommendation

**Worth proceeding.** The core thesis holds locally: activity (new patches, builds passing) is separable from progress (runtime evidence improving) with µs-cost deterministic logic, and the Jev boundary is clean — the product already reports and policies usefully with `JEV: unavailable`.

Recommended POC-01 inputs, in order:
1. One live capture loop: agent-device `logs start/stop` + `snapshot --diff` around a real attempt on an emulator, replacing representative fixtures with recorded truth.
2. Gradle build/test output ingestion so `build.status` / `tests.failedCount` come from real tool output (the only fixture-supplied fields left).
3. A real Jev call (needs an API key) to measure actual latency/tokens and to calibrate the three probabilities against the deterministic signals.

**Stopped here per §17 — awaiting user approval before any further implementation.**
