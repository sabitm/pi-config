# vcc-hybrid

Two-stage context compactor for pi. Vendored + hybrid.

## What this is

A pi extension that intercepts compaction (`session_before_compact`) and produces a summary without sending the full serialized session to an LLM.

**Stage 1 (algorithmic, no LLM):** pi-vcc's extraction pipeline normalizes messages, filters noise, extracts semantic sections (Session Goal, Files And Changes, Commits, Outstanding Context, User Preferences), and builds a ranked chronological brief under a size-relative token budget. Produces a ~1.1-2k-token distillate.

**Stage 2 (LLM synthesis, optional):** a short `complete()` call feeds the distillate to a model with a synthesis system prompt. The LLM reasons over the clean extracted signal rather than the raw session, so the input is ~50x smaller than stock pi compaction. Falls back to the pure distillate on any error, abort, or stream drop, so compaction never fails.

## Config

`~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load):

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "hybridSynthesis": true,
  "summaryModel": null,
  "debug": false
}
```

- `overrideDefaultCompaction: true` routes `/compact`, auto-threshold, and overflow through this extension. `false` handles only `/pi-vcc`.
- `hybridSynthesis: true` (default) runs the LLM synthesis pass. `false` is pure pi-vcc (no LLM, fastest, deterministic).
- `summaryModel: null` uses the active session model. `{"provider":"google","id":"gemini-2.5-flash"}` overrides for synthesis only.
- `debug: true` writes a snapshot to `/tmp/vcc-hybrid-debug.json` per compaction.

## Commands and tools

- `/pi-vcc [keep:N] [prompt]` manual compaction.
- `/pi-vcc-recall <query> [scope:all] [page:N]` search raw session JSONL (lossless history across compactions).
- `vcc_recall` tool: same search, callable by the agent.

## Provenance

Stage 1 is vendored from `@sting8k/pi-vcc@0.4.0` (MIT) under `vcc/src/`. The hybrid hook in `hybrid.ts` composes pi-vcc's `compileRanked` distillation with a `complete()` synthesis pass and a distillate fallback.
