# POC-02 — Real Session Replay — Findings

- Date: 2026-09-22
- Branch: `poc/02-real-session-replay` (from POC-01 final commit `aaa5501`)
- Data source: real Claude Code history at `~/.claude/projects` (read-only; Claude Code 2.1.88). Codex history (`~/.codex/sessions`, rollout JSONL) discovered but not adapted — Claude first, per spec §11.

## 1. Verdict: PASS

> 실제 coding-agent history에서 Verification Debt와 dead-end exploration을 의미 있게 발견할 수 있는가?

**PASS — one real, human-verifiable finding, zero false positives.** Not STRONG PASS: the available history contains exactly one session with implementation activity, so only one class of finding (verification debt) is observable in real data. Dead-end and productive-progress detection are implemented and unit-verified, but there was no real instance to confirm them against (marked INCONCLUSIVE, never guessed — spec §7).

This POC was the product kill gate. The gate held: attempt/evidence reconstruction from a real transcript was possible, deterministic, and produced a segment a human reader of the same transcript would immediately recognize as true.

## 2. Real history inspected (privacy: metadata only)

| Metric | Value |
| --- | --- |
| Session JSONL files found | 7 (across 8 project directories) |
| Sessions with reconstructable implementation activity | **1** (`415efbff`, 125 lines / 93 parsed, from 2026-08-06) |
| Sessions without tool activity | 6 (short sessions, no `tool_use` blocks — nothing to reconstruct, not a parser failure) |
| Tool calls in the usable session | 33 — Read 8, Grep 5, Glob 3, TodoWrite 2, **Edit 11**, **Bash 4** |

## 3. The real finding (verbatim `npm run poc:02` output)

```
Agent Pigeon Replay

Session analyzed      415efbff
Attempts              1
Implementation calls  11
Verification runs     0

Verification Debt
  Attempts 1–1: 11 implementation calls were made without collecting any verification evidence
  Confidence    HIGH

Verdict:
  ⏸ Verification debt: 11 implementation calls were made without collecting any verification evidence
Confidence:
  HIGH

Summary: 7 session(s) inspected · 1 with implementation activity · 6 without reconstructable attempts
```

Human check: a reader of that transcript sees 11 successive file edits (plus reads/greps and four non-verification shell commands — inspecting `package.json`, `pwd && ls`) and **no build, no test, no device run anywhere in the session**. The agent changed code and never once asked the app or the test suite whether anything improved. That is precisely the verification-debt pattern the product exists to catch, and it was surfaced with zero false-positive risk.

## 4. Pipeline (spec §3–§5)

```
~/.claude/projects/**/*.jsonl  (raw — read in memory, NEVER committed)
  → parseClaudeSessionJsonl()   sanitize: commands/paths/output/prompts dropped;
                                 only tool names, booleans, counts, ms offsets,
                                 sha256-8 hashes survive
  → segmentIntoAttempts()       implementation(s) → verification run(s) = 1 attempt;
                                 window closes when a NEW implementation begins
                                 (build→test sequences stay in one attempt);
                                 trailing implementations = debt attempt
  → AttemptEvidence[]           feeds the unchanged POC-00 evidence schema
  → analyzeAttempts()           verification debt / dead-end (failure-signature
                                 identity) / productive progress + confidence
```

- **Attempt segmentation (spec §5)**: tool calls are never attempts. A session with 11 edits and no verification correctly reconstructs as ONE unverified window — the debt is real, not fragmented into fake "attempts".
- **Failure-signature identity for dead-ends**: `sha256-8` of the first normalized error line (digits/hex/paths masked before hashing). Same failure → same hash across attempts even as line numbers churn; a different failure → different hash. Unit-tested.
- **Classification**: Bash commands are classified in memory (test > device > build > other) and the command text is discarded. Failed-test counts are extracted as NUMBERS ONLY (`/(\d+)\s+tests?\s+failed/` etc.) — no text persists.
- **Codex (spec §11)**: rollout JSONL files exist under `~/.codex/sessions/YYYY/MM/DD/`; discovery only. No adapter — Claude first.

## 5. Critical rule compliance (spec §7)

- Dead-end in the real data: **INCONCLUSIVE** — the one usable session contains no failed verification, hence no failure signature exists; nothing was forced into the dead-end bucket.
- Productive progress in the real data: **INCONCLUSIVE** — no verification results exist to compare.
- False positives found: **0** (nothing was flagged; the single flag is directly verifiable by reading the transcript).
- Confidence is never a disguised model probability: HIGH/MEDIUM/INCONCLUSIVE come from deterministic run-length and evidence-availability rules only.

## 6. Validation tests (39/39 passing overall)

- Real sanitized fixture (`fixtures/replay/sanitized-415efbff.json`) replays to exactly the recorded finding (11 implementation calls, 0 verification runs, HIGH debt).
- Synthetic-but-realistic sessions: dead-end detection across same-failure/novel-patch runs, productive progress (`18 → 9` failures, build fail→pass), multi-attempt debt, and the false-positive guard (a single unverified edit is NOT called a dead end; empty evidence → INCONCLUSIVE).
- Privacy invariant asserted in tests: the committed sanitized fixture contains no paths, no commands, no output text; every hash field is exactly 8 hex chars or null.

## 7. Privacy treatment (spec §3)

- Raw transcripts are read from `~/.claude/projects` but are **never written to the repo** — not as fixtures, not in reports, not in logs.
- The only committed derivative is the sanitized event stream: `{eventType, timestampOffset, toolName, ok, verificationKind, changedFilesCount, changeSetHash, failureSignatureHash, testsFailedCount, durationMs}`.
- Personal paths are never stored even in sanitized form — path identity is only ever a hash; report identity is the 8-char session id.
- `--save-sanitized <dir>` exists to produce such derivatives deliberately; nothing else writes.

## 8. Kill-gate assessment (spec §10)

- Reconstruction from real sessions: **possible** (attempts, calls, verification runs all recovered deterministically).
- False positives: **none observed**; the INCONCLUSIVE-by-default stance held.
- Useful vs reading the transcript by hand: the finding compresses 125 transcript lines into one verdict a human can verify in seconds. For a session of this size the advantage is modest (honest), but the mechanism — and the debt pattern it caught in the wild — is exactly the product's premise.
- Not blocking POC-03: PASS.

## 9. Commits

- `feat: replay Claude coding sessions (sanitized event extraction)`
- `feat: detect verification debt and dead-end exploration in real sessions`
- `test: add sanitized replay cases from real history`
- `docs: record POC-02 findings`
