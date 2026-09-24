# POC-03 — Live Claude Observation — Findings

- Date: 2026-09-22
- Branch: `poc/03-live-observe` (from POC-02 final commit `848a646`)
- Claude Code: 2.1.88 installed; hooks configured at **project scope in a sandbox** (global `~/.claude/settings.json` untouched)
- Sandbox: `<Home>/agent-pigeon-poc03-sandbox` (deliberately seeded with two failing tests so a live session would produce edit → test → edit → test activity)

## 1. Verdict: BLOCKED (live leg) — everything independently verifiable PASSED

> Claude Code를 눈에 띄게 느리게 하지 않으면서 live coding activity를 관찰하고 attempt/evidence timeline을 구축할 수 있는가?

- **Live-agent leg: BLOCKED, not FAIL.** The user's Claude Code account hit its monthly quota during the live run: `claude -p` returned `API Error: 402 insufficient_quota`. No live session could be driven. This is an environment/resource limit (per the POC instructions: environment shortage is BLOCKED, not FAIL), so per the stated policy the remaining independently verifiable parts were completed and POC-03 does NOT proceed to any intervention work.
- **Hook capture pipeline: verified for real** (100/100 invocations of the production hook script, correct sanitized events every time).
- **Timeline reconstruction: verified end-to-end** — the unmodified production hook was driven by five real-format PostToolUse payloads (schema taken from the real transcripts parsed in POC-02) and the offline worker reconstructed a correct attempt timeline from its events. This is a simulated *trigger* (labeled as such), not a simulated *pipeline*: everything from the hook script onward is the real code path.

## 2. Architecture (spec §2, §3, §6)

```
Claude hook (PostToolUse, project-scoped settings)
    ↓ stdin JSON read → extract → append ONE JSONL event → exit 0   [hot path]
~/.agent-pigeon/events.jsonl
    ↓ worker (one-shot `npm run poc:03`, NOT a daemon)
sanitize → attempt windows (POC-02 segmenter, reused) → AttemptEvidence → POC-00 evaluator
```

Hot path does NOT do (verified by source contract test): Jev, network/fetch, git, ADB, agent-device, transcript scanning, LLM calls. It stores only: `ts, sessionId (8 chars), toolName, ok, fileHash (sha256-8 of edited path), verificationKind (test|build|device|other), testsFailedCount (a bare number extracted from Bash output)`. No commands, no paths, no output text, no prompts.

- Hook matcher: `Edit|Write|MultiEdit|Bash` (minimal event set; PostToolUse only — no behavior modification, no additionalContext, no Stop blocking: **zero nudge surface**, spec §9).
- Hook failures are swallowed (`try/catch` → `exit 0`); a broken observer must never break the agent.
- `--save-fixtures`-style persistence was not needed; the sandbox settings file is the only artifact outside the repo.

## 3. Hook hot-path latency (spec §7) — real numbers, unmanipulated

100 invocations of the production hook with a representative PostToolUse payload (Windows, Node v24.19.0):

| Metric | Hook invocation (process wall time) |
| --- | --- |
| p50 | **101.0 ms** |
| p95 | **119.3 ms** |
| max | **134.4 ms** |
| min | 93.3 ms |

Attribution: bare `node -e ""` startup on this machine measures p50 ≈ 90.7 ms / max ≈ 100.1 ms. So the Node runtime spawn dominates; the hook's own logic is ~1–3 ms (in-process hashing + regex + one appendFileSync).

**Honest assessment vs the <10 ms target: NOT met at process granularity.** Per-tool-call overhead of ~100 ms is small relative to typical tool executions (hundreds of ms to seconds), and PostToolUse runs after the tool completes, but it is not free and would multiply across a long session. Before productization the hook should become a compiled single-binary (Go/Rust, expected ~1–5 ms) or a persistent listener with a thin writer. Numbers reported as measured; nothing was tuned away.

## 4. Event capture correctness

Bench invocations produced 100/100 valid JSONL events. Example event (from the live-sim run):

```json
{"ts":"2026-09-22T05:20:01.565Z","sessionId":"aaaa1111","toolName":"Bash","ok":false,"fileHash":null,"verificationKind":"test","testsFailedCount":1}
{"ts":"2026-09-22T05:20:02.368Z","sessionId":"aaaa1111","toolName":"Edit","ok":null,"fileHash":"f9ad96ce","verificationKind":null,"testsFailedCount":null}
```

## 5. Attempt timeline reconstruction (spec §8 equivalent)

The live session was quota-blocked, so the tool sequence a fix-and-verify session produces (test fail → edit → test fail → edit → test pass) was driven through the real hook as real-format payloads. Worker output:

```
Agent Pigeon — POC-03 live timeline

Events                5 (2 implementation, 3 verification, 0 other)
Attempts              2
Session(s)            1

Attempt timeline

Attempt 1  +0.9s  1 edit  test: FAILED (1 failing)
Attempt 2  +2.5s  1 edit  test: passed

Verification debt     LOW
Dead-end candidate    no
Finding               productive (attempts 1–2, MEDIUM): failed tests 1 → 0
Policy                CONTINUE

Verdict

• No strong signal yet — continue.

Worker processing time 1699 µs
```

Details worth noting:

- The **baseline** test run (failing before any edit) is correctly discarded — it attaches to no attempt (a segmentation bug where stale pre-attempt verifications leaked into the next attempt was found by the new tests and fixed).
- A passing test run infers `failedCount = 0`, so the worker detects the productive recovery (`failed tests 1 → 0`) deterministically.
- The evaluator's verdict stays conservative: a single improving signal yields MEDIUM gain, so policy stays CONTINUE — consistent with POC-00 scoring; the timeline itself carries the fail→pass story.
- A stacked-unverified-edits stream (3 edits, no verification) escalates to `VERIFY_FIRST` via the replay-layer debt finding even though POC-00's attempt-streak debt stays LOW — both layers are deterministic and now surfaced together.
- Worker processing time: ~1.1–1.7 ms per stream (offline, not hot path).

## 6. No-nudge compliance (spec §9)

The hook returns no output, adds no context, blocks nothing, and the worker is offline and manual. Nothing in POC-03 can alter Claude's behavior. Jev was not placed anywhere near the hot path (spec §10) — it was not called at all.

## 7. PASS/HARD-FAIL check (spec §11–§12)

| Criterion | Status |
| --- | --- |
| Live Claude events captured | **BLOCKED** (402 quota) — hook capture itself proven with real-format payloads |
| Claude session works normally with hook installed | Not observable without a live session; hook is output-free and failure-swallowing by construction |
| Event timeline reconstructable | **PASS** (worker test + live-sim run) |
| Hook latency practical | **PARTIAL** — ~100 ms/call measured; attributed to Node startup; flagged for binary hook before productization |
| Evaluator input without raw sensitive content | **PASS** (privacy contract asserted in tests; only hashes/counts/booleans stored) |
| Hard fail (noticeable slowdown / brittle capture / needs full transcript) | **Not hit** — but the latency target miss is reported honestly |

## 8. Commits

- `feat: capture Claude events with zero-nudge PostToolUse hook`
- `feat: reconstruct live attempt timeline offline (poc:03 worker)`
- `perf: measure hook hot-path latency (p50/p95/max over 100 runs)`
- `docs: record POC-03 findings`
