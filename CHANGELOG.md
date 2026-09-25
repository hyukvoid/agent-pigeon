# Changelog

## 0.1.2 — version output hotfix

- Fixed `--version` reporting the previous package version.
- No analysis, privacy, or report behavior changes.

## 0.1.1 — branding polish

- Added the Agent Pigeon pixel-art mascot, compact terminal dot pigeon, and refreshed README.
- No analysis or privacy behavior changes.

## 0.1.0 — local-analysis release candidate

Initial public-surface scope: **`agent-pigeon replay`**, plus `flight`,
`compare`, and `share` (SVG card on stdout).

- Parses local Claude Code (`~/.claude/projects`) and Codex
  (`~/.codex/sessions`) history, read-only. Replay creates no files and
  performs no network access.
- Turn-based attempt reconstruction (multi-edit model turns count as one
  implementation attempt, not N).
- Corrected verification classification, including package-manager script
  indirection (`npm run check` etc.); lint/format scripts deliberately do not
  count as recognized verification.
- Conservative reporting: recognized verification runs, unverified
  implementation stretches, and healthy fail→pass verification loops.
- `--json` machine-readable aggregate; history-directory overrides.

**Deliberately withheld** (researched; see `docs/research/`): live
VERIFY_FIRST governor (failed its behavioral dogfood — precision 0/6 — and is
preserved as experimental code), RETHINK, HUMAN_REVIEW, Jev semantic
evaluation.
