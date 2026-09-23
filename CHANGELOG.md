# Changelog

## 0.1.0 — replay-only release candidate

Initial public-surface scope: **`agent-pigeon replay`** only.

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
