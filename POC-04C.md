# POC-04C — Autonomous Evidence Sprint — Findings

- Date: 2026-09-22
- Branch: `poc/04c-autonomous-evidence` (from `poc/04b-real-corpus-gate` `fd4f653`)
- Final regression: **71/71 tests pass**

## What I chose to investigate (and why)

**E1 — Why were only 9/350 sessions reconstructable?** Every other open question (real productive windows, more dead-ends, mobile evidence, token burn) was blocked behind the reconstruction rate. If the pipeline was losing evidence, fixing it was the highest-information move; if the corpus was genuinely thin, that would confirm HOLD.

**E2 — False-positive & productive validation on the recovered corpus.** A detector that has only ever seen failures is dangerous. After E1, I audited every candidate with the single question: *does the governor stay silent during legitimate iterative debugging, and do the labels survive human inspection of the underlying output?*

## What I deliberately did NOT investigate

- Controlled Android session (Gradle is not installed on this machine; POC-01 already proved the mobile runtime chain end-to-end — a CONTROLLED Android run would have re-proven a proven link).
- Jev (no key on this machine; and E2 produced no genuinely ambiguous real case that deterministic evidence could not decide — the precondition for a meaningful Jev test never occurred).
- Claude live behavior (quota), RETHINK implementation (forbidden without evidence), binary hooks, dashboards, installers.

## The decisive discovery chain (E1)

1. The 18,900 `exec` calls in Codex rollouts are **not shell commands** — they are **JavaScript programs that drive inner tools** (`await tools.apply_patch(...)`, `await tools.exec_command(...)`, `await tools.shell_command(...)`). The original adapter classified the whole program text and missed all inner edits.
2. Inner calls found corpus-wide: `tools.apply_patch` ×**3,738** (invisible file edits), `tools.exec_command` ×6,060, `tools.shell_command` ×4,916 — plus `event_msg/item_completed` items that explicitly declare `FileChange` (4,030) and `CommandExecution` (8,130).
3. Adapter v2 extracts, conservatively: embedded `*** Begin Patch … End Patch` bodies → implementation events (content-fingerprinted, file counts from `*** Update/Add/Delete File:` markers), and inner `exec_command/shell_command` string arguments that classify as build/test/device → verification events. Everything else stays 'other'.

**E1 result (ORGANIC corpus, before → after):**

| Metric | POC-04B | POC-04C | Δ |
| --- | --- | --- | --- |
| Usable sessions | 9 | **69 → 73** (corpus still growing) | ×8 |
| Attempts reconstructed | 14 | **293 → 297** | ×21 |
| Implementation calls | 581 | **4,560** | ×7.8 |
| Verification events | 26 | **392** | ×15 |
| Mobile-flagged sessions | 3 | **18** | ×6 |

H2 ("attempt boundaries too strict") and H4 ("sessions are fragments") were refuted: the boundary rules were fine — **the tool schema was unparsed**.

## The decisive discovery chain (E2): a real false-positive factory

With recall restored, precision auditing exposed two evidence-quality bugs — both now fixed and regression-tested:

1. **Failure-signature coarseness.** The original signature hashed the FIRST error line — which for Codex outputs is the harness wrapper **"Script failed"** (and after first-line filtering, the wrapper triple "Wall time N seconds / Output: / Script error:"). Result: every failed command in every project shared one signature (`005acf21`, later `da8e02ef`), producing **false dead-end candidates across unrelated sessions**. 
   Fix: wrapper/diagnostic lines are filtered before hashing, and the signature hashes the **LAST 3 content lines** (where build/test summaries actually live).
2. **Sandbox-launch contamination.** Many "build:FAIL" events were `windows sandbox: orchestrator_helper_launch_failed` — the command **never ran**. These now downgrade to 'other' (no verification evidence collected): they can neither mask verification debt nor fabricate fail→pass progress.

**E2 result — retracted and re-validated (ORGANIC):**

| Finding | Before hardening | After hardening |
| --- | --- | --- |
| Dead-end windows | 4 candidates (incl. 1 HIGH "4 patches, same failure") | **0 — all were false positives** from wrapper-line hashing |
| Productive windows | 2 | **2 — survived** (mobile gradle build fail→pass, session `019f2132`) |
| Verification-debt windows | 4 | **28** (3 mobile; one window burned ≈**1,613,027 tokens** with zero verification) |
| False positives found by audit | — | 4 (the dead-end set) — **now impossible by construction** (opaque wrapper text hashes to a distinct opaque-failure identity, not to other failures) |

The flagship audited productive session (`019f2132`, mobile gradle, 11 attempts in ~1 hour): attempts 4–7 were **sandbox-launch noise** (not real failures), attempts 8 and 11 real gradle **passes**, zero debt — the governor would have stayed completely silent through this legitimate debugging session, which is precisely the desired behavior.

## Episode boundaries (temporal)

Attempt-start gaps in the audited sessions range 27 s – 26 min; the old "16-day resume" example dissolved with its false-positive signature. With no surviving cross-gap candidate, there is **insufficient evidence to set a gap threshold** — recorded as UNRESOLVED; gap metadata is now retained per attempt for a future data-driven rule.

## Evidence ledger (ORGANIC / CONTROLLED / SYNTHETIC)

- **ORGANIC** (real history): 367 sessions scanned; 73 usable; 297 attempts; 4,560 implementation calls; 399 verification events; 2 productive windows; 28 debt windows; 0 dead-end windows; 0 false positives after hardening.
- **CONTROLLED**: none created this sprint (prior controlled evidence: POC-01 emulator REAL A/B/C).
- **SYNTHETIC**: Codex rollout unit fixture (interface tests only — counts as zero product validation).

## Surprising findings (contradicting prior assumptions)

1. The corpus's dominant tool is a JS orchestrator, not a shell — "exec" misled every earlier assumption about implementation detection.
2. Our own dead-end evidence was an artifact: **the POC-04B "confirmed real dead-end" is retracted** as a false positive (see correction banner in [POC-04B.md](POC-04B.md)). Precision-first auditing caught our own product's would-be feature firing on noise.
3. Verification-only sessions (47) outnumber coding sessions — agents are frequently used to run/inspect tests without editing, which is a replay-product audience but not a governor audience.
4. Verification debt is not rare: 28 windows, some burning **hundreds of thousands to 1.6 M tokens** with zero verification — the strongest "why install this" evidence collected so far.
5. Real productive verification loops exist and are visible to the pipeline (gradle fail→pass twice in one session) — the governor correctly stayed silent.

## Product thesis update

**Chosen direction: (B) General Proof-of-Progress Governor, with mobile as the first deep adapter.**
Evidence: the organic corpus is general-coding-dominant (that is where the 28 debt windows live), while the single richest end-to-end validation we own is mobile (POC-01 runtime chain + session `019f2132`'s real gradle loop). The core model (events → attempts → runtimeChange/evidenceGain/goalProgress → policy) is already source-agnostic; mobile is where verification evidence is highest-fidelity (build + tests + device state), so it stays the flagship adapter — not a ceiling. Option (A) mobile-only is contradicted by the data (mobile candidates are 3/31); options (D)/(E) were not supported by anything observed this sprint.

## RETHINK verdict

**KEEP DISABLED.** The only real dead-end evidence collapsed under audit (signature coarseness). The rebuilt tail-3 signature now separates real failures correctly, but zero organic dead-end windows survive in the corpus. RETHINK may be revisited only after a future corpus contains confirmed ≥3-attempt stable-outcome windows.

## Jev verdict

**REMOVE FROM MVP** (value **UNJUDGED** — no key; and every organic candidate this sprint was decided deterministically, so the precondition for a meaningful Jev test never occurred). The provider interface remains optional/experimental.

## Product confidence

**Proven:** sanitized reconstruction at scale (×21 attempts); VERIFY_FIRST debt detection on real data (28 windows, 0 false positives after hardening); silence during legitimate debugging (productive sessions produce no intervention); privacy invariants under concurrency; end-to-end mobile runtime evidence (POC-01).
**Still speculation:** live-governor effect on agent behavior (Claude quota); RETHINK value (no reliable evidence); mobile runtime evidence at corpus scale (3→18 flagged sessions, none yet with candidates); Jev's incremental value.

## Next action

**GO — prepare v0.1 around the existing verified capability**: replay (`poc:02`/`poc:04b` corpus mining) + the VERIFY_FIRST governor (observe → deterministic decision → once-per-episode factual warning), general-core with mobile as flagship adapter, Jev removed from the MVP path. RETHINK stays disabled pending the data collection defined in HOLD items (more verification-rich sessions; mobile sessions; episode-gap metadata).

**STOP. Awaiting user review.**
