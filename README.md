# Agent Pigeon
Proof-of-progress for mobile coding agents.

## POC-00

```bash
npm install
npm run poc:00                          # run all three mandatory scenarios
npm run poc:00 -- --scenario b --print-payload
npm test
```

Jev is optional: without `JEV_API_KEY` the CLI reports `JEV: unavailable` and the deterministic report stays complete. See [POC-00.md](POC-00.md) for findings and measurements.
