> **STATUS (v0.1 release)**: the live governor described here did NOT ship. A real Claude-in-Kiro dogfood produced 0 useful warnings out of 6 (4 false positives) and v0.1 is REPLAY-ONLY. Preserved as research — see [docs/research/CLAUDE-KIRO-DOGFOOD.md](CLAUDE-KIRO-DOGFOOD.md) and the repository README.

# POC-03.5.1 + POC-04A — Fingerprint Hardening & Safe Governor — Findings

- Date: 2026-09-22
- Branch: `poc/04a-safe-governor` (from POC-03.5 final commit `611c72f`)
- Scope: PART A (fingerprint hardening) · PART B (git backup) · PART C (POC-04A safe governor)
- Final regression: **63/63 tests pass** (was 54; +9 fingerprint/governor tests, all prior tests updated and green)

## PART A — Fingerprint Hardening (POC-03.5.1)

### Design

```
OLD:  sha256(whitespaceCollapsedPayload)[0:8]        — 32-bit, guessable by candidate matching
NEW:  HMAC-SHA256(perInstallSecret, canonicalPayload)[0:32 hex]   — 128-bit
```

- **Per-install secret**: 32 random bytes (hex), generated locally on first use, stored at `<AGENT_PIGEON_HOME | ~/.agent-pigeon>/secret.key` with mode 0600 — **outside any repository, never committed, never present in any event, fixture, or Jev payload** (tests enforce; `git status`/repo-path assertions included).
- **Canonicalization (serialization mechanics only)**:
  - stable JSON layout with explicit key order: `{v:2, op, parts}`
  - line endings normalized (CRLF/CR → LF) — same edit from different tooling hashes identically
  - **NO whitespace collapsing** (removed from POC-03.5): indentation and spacing are change semantics — an indentation-only change now yields a different fingerprint
- **`op` distinguishes shapes**: `edit` (old,new) / `write` (content) / `notebook` (new_source) / `multi-edit` (aggregate pairs) / `paths` (fallback when no content is available — path lists are also HMAC-keyed now).
- Mirror implementation retained (hook .mjs ↔ TS) with the mirror-contract test: same secret + same payload → identical 32-hex digest.
- The deployed observer copy (`~/.agent-pigeon/hook.mjs`) and delivery copy were refreshed; a deployed-chain smoke (real hook → processor → delivery on an isolated home) passes.

### Honest security claim (replacing the POC-03.5 claim)

A bare 32-bit digest does **not** protect against reconstruction by candidate matching. With the keyed construction, candidate matching requires the per-install secret; without it, stored fingerprints are opaque. They must still be treated as **sensitive metadata** — they are commitments to content, not anonymous data. POC-03.5.md has been corrected accordingly.

### Tests (mandated 1–6)

| # | Requirement | Result |
| --- | --- | --- |
| 1 | same exact edit → same fingerprint | **PASS** (two hook invocations, same install) |
| 2 | different edit in same file → different | **PASS** |
| 3 | indentation-sensitive change → different | **PASS** (whitespace collapsing removed) |
| 4 | raw source never persisted | **PASS** (secret-bearing edit; events contain only the 32-hex digest) |
| 5 | secret never enters repo/events/Jev payload | **PASS** (events + decision checked; no secret file under repo; Jev-payload test asserts no 32-hex fingerprint travels) |
| 6 | existing POC tests remain green | **PASS** (54 prior → updated where they asserted 8-hex/whitespace behavior; 63/63 total) |

## PART B — Git backup

- Remote: **NOT CONFIGURED — cannot be configured safely.** Findings: no `gh` CLI; credential helper `manager` and an SSH key exist, but `git ls-remote https://github.com/hyukvoid/agent-pigeon.git` → *Repository not found*, and SSH → *Permission denied (publickey)*. The repo owner cannot be verified from this machine, so per instructions **no repository was created under any account**.
- **OPERATIONAL RISK (flagged): all POC work currently exists only on this machine.** If this disk dies, POC-00–04A history is lost. Recommended user action: create the private repo under the intended owner, then `git remote add origin <url> && git push -u origin main poc/00-proof-of-progress poc/01-real-mobile-evidence poc/02-real-session-replay poc/03-live-observe poc/035-reality-gate poc/04a-safe-governor`.

## PART C — POC-04A Safe Governor

### Question

> Can Agent Pigeon safely intervene ONLY when an agent keeps changing implementation without collecting verification evidence?

**Yes — locally proven end-to-end.** (LIVE BEHAVIOR EFFECT: DEFERRED_BY_ACCOUNT_ACCESS — Claude quota still unavailable; the complete intervention contract, message, anti-spam and failure behavior are validated locally with the real hook scripts; no claim is made that Claude behavior improved.)

### Architecture (delivery reads a precomputed decision only)

```
observe hook (async, POC-03)  →  events.jsonl
governor processor (one-shot background, `npm run governor:process`)
    → deterministic decision + anti-spam latch (governor-state.json)
    → decision.json {policy, message, delivered}
deliver hook (UserPromptSubmit; one small file read, at most one write)
    → emits hookSpecificOutput.additionalContext ONCE, marks delivered
```

- The processor does pure local file I/O; the delivery hook does one read + at most one write. Neither calls Jev, the network, agent-device, transcript scanning, nor heavy state computation. **No Stop blocking anywhere.**
- Policies implemented in the governor: **OBSERVE (silent)** and **VERIFY_FIRST** only. RETHINK and HUMAN_REVIEW are not computable by this module. Jev is not involved at any point.

### Trigger (strong deterministic evidence only)

- ≥ **3 materially DISTINCT implementation changes** (distinct **content** changeFingerprints; path-basis events never establish distinctness — unit-tested)
- AND **no** build/test/device verification event since the first of those changes (a FAILED test run still counts as verification — evidence was collected; unit-tested)
- Never triggered by: elapsed time (50 identical edits over an hour → SILENT), tool-call count, token usage, repeated identical edits, agent language. (Unit-tested by construction — the decision function has no such inputs.)

### Message (factual, short — no "you are stuck / approach is wrong / rethink")

```
Agent Pigeon

3 materially different implementation changes were made without collecting new verification evidence.

Verify the current app before another implementation change.
```

### Anti-spam

VERIFY_FIRST fires **once per debt episode**. The episode is keyed by its first content fingerprint; after firing, the latch holds even as the episode grows (a 4th edit stays silent — tested). The latch clears only when a verification event occurs (debt reset — tested), after which a new episode may fire exactly once more (tested).

### Mandatory tests A–F (all end-to-end through the REAL hook scripts + processor + delivery)

| # | Scenario | Result |
| --- | --- | --- |
| A | edit A, B, C, no verify | **exactly ONE VERIFY_FIRST**; delivery emits the message once; 4th edit → SILENT |
| B | edit A, B, test, edit C | no warning |
| C | same edit ×3 | no trigger (1 distinct fingerprint) |
| D | A/B/C → VERIFY_FIRST → test → reset | latch cleared; new episode (D/E/F) fires once more |
| E | productive fix/test loop | never warns |
| F | corrupt / missing decision output | delivery exits 0, prints nothing — the agent continues normally |

Unit tests additionally pin: time/tool-count/repeated-edit non-triggers, failed-tests-count-as-verification, path-basis non-distinctness.

### Wiring note (deployment)

The observe hook can chain the processor via `AGENT_PIGEON_WORKER` (detached spawn, off the hot path); in POC-04A the chain was validated by explicit invocation, and production wiring (scheduler/hook-chain + `async: true` config from POC-03.5) is left as install-time configuration, not product code.

## Success criteria (§SUCCESS)

| Criterion | Result |
| --- | --- |
| One safe deterministic intervention exists | **PASS** (VERIFY_FIRST only) |
| No Jev dependency | **PASS** |
| No RETHINK behavior | **PASS** (governor cannot emit it; core evaluator still computes it for reporting, governor layer ignores it) |
| Warning is anti-spam | **PASS** (once per episode; latch + reset tested) |
| Productive workflows remain silent | **PASS** (E) |
| Privacy guarantees remain intact | **PASS** (HMAC fingerprints; no raw source; secret never leaves machine; Jev payload test) |
| Observation remains non-blocking by design | **PASS** (async hook + offline processor; delivery hook is a single file read) |
| All regression tests pass | **PASS** (63/63) |
| HUMAN_REVIEW not implemented | **PASS** (reserved; the only mention is the pre-existing provisional build-fail mapping in the evaluator, which the governor never delivers) |

## Hard-fail check

No condition hit: novelty does not require storing raw source; goalProgress separation held from POC-03.5; no productive→dead-end misclassification; dead-end/Jev paths unchanged; privacy invariants hold under the new scheme.

## Unresolved risks / notes

1. **Local-only history (operational risk)** — see PART B; needs one manual remote setup by the owner.
2. Live-agent effect of VERIFY_FIRST delivery remains unverified until Claude access returns (UserPromptSubmit `additionalContext` is the documented safe mechanism; actual behavioral effect unmeasured).
3. `governor-state.json` is machine-local: wiping `~/.agent-pigeon` resets anti-spam memory (acceptable; events are the source of truth).
4. MultiEdit/Write fingerprints cover the tool payload, not the resulting file tree — two different tools producing identical file states can hash differently. Conservative direction only.

## Commits

- `feat: HMAC-SHA256 per-install change fingerprints (128-bit) with secret isolation`
- `feat: POC-04A safe governor (VERIFY_FIRST once per debt episode, anti-spam)`
- `test: governor scenarios A-F and hardened fingerprint contracts`
- `docs: record POC-03.5.1 + POC-04A findings; correct fingerprint privacy claim in POC-03.5`

**STOP. POC-04B not implemented. Awaiting user review.**
