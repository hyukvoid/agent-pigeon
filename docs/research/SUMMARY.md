# Research History (POC archive)

Agent Pigeon v0.1 is **replay-only**. The documents in this directory are the
research record that led there — kept for transparency, not as documentation
of current behavior. They contain conclusions that were later revised; each
affected document carries a correction banner where applicable.

## Reading order

| Document | What it established |
| --- | --- |
| [POC-00.md](POC-00.md) | Deterministic evidence pipeline; synthetic scenarios |
| [POC-01.md](POC-01.md) | Real Android runtime evidence (emulator + agent-device) — the flagship adapter |
| [POC-02.md](POC-02.md) | Real session replay; verification debt exists in the wild |
| [POC-03.md](POC-03.md) | Live observation architecture (hooks), latency |
| [POC-03.5.md](POC-03.5.md) | Content fingerprints; runtimeChange/evidenceGain/goalProgress split; **superseded fingerprint hardening in POC-04A.1** |
| [POC-04A.md](POC-04A.md) / [POC-04A.1.md](POC-04A.1.md) | Safe-governor design; live delivery gate (live behavior unvalidated) |
| [POC-04B.md](POC-04B.md) | Real corpus gate (⚠ its one confirmed dead-end was later retracted — see POC-04C) |
| [POC-04C.md](POC-04C.md) | Codex inner-tool parsing (×21 attempts); direction decision |
| [VERIFY-FIRST-RETHINK.md](VERIFY-FIRST-RETHINK.md) | Turn-based debt unit; controlled FP evaluation |
| [CLAUDE-KIRO-DOGFOOD.md](CLAUDE-KIRO-DOGFOOD.md) | The real live dogfood: 6 warnings, 0 useful, 4 false positives, 2 annoying — why live is not in v0.1 |
| [LIVE-VERIFY-FIRST-FINAL-GATE.md](LIVE-VERIFY-FIRST-FINAL-GATE.md) | Final live gate (watermark policy) — replay-only recommendation |
| [FINAL-REPORT.md](FINAL-REPORT.md) | POC-01–03 consolidated report (pre-replay-only) |
| [V0.1-RC.md](V0.1-RC.md) | Superseded v0.1-RC (contained the live governor; see instead the repository README) |
| [CHANGELOG-0.1.0-draft.md](CHANGELOG-0.1.0-draft.md) | Draft changelog from the RC iteration (live references are historical) |

## Current state

The product is `agent-pigeon replay` — see the repository README. The live
governor, RETHINK, HUMAN_REVIEW and Jev are **not** part of v0.1; their code
and tests are preserved under `experimental/` in the repository.
