# Security Policy

Agent Pigeon v0.1 is a **local, read-only analysis tool**.

## Data flow

- **Reads:** Claude Code history (`~/.claude/projects/**/*.jsonl`) and Codex
  history (`~/.codex/sessions/**/*.jsonl`), read-only. Nothing else on your
  machine is read.
- **Writes:** nothing. `agent-pigeon replay` creates no files, stores no
  state, keeps no cache.
- **Network:** none. The replay path contains no network code.

## What appears in output

Aggregate counts, short session identifiers (first 8 characters of session
UUIDs), confidence labels, and turn counts. Source code, diffs, shell
commands, prompts, reasoning, and transcript text are **never** included in
output.

## Reporting a vulnerability

Open a GitHub issue at <https://github.com/hyukvoid/agent-pigeon/issues>
marked `security`, or contact the repository owner privately through GitHub.
Please do not disclose publicly until a fix is available.
