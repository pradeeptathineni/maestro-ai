---
name: maestro-context-engineering
description: Keep Maestro repository work within a deliberate context budget. Use for cross-cutting repository analysis, large or noisy command results, architecture review, repeated searches, context pressure, or when deciding whether a context, memory, mapping, compression, or orchestration tool belongs in this repository.
---

# Maestro context engineering

Use the least lossy context mechanism that answers the current question.

1. State the concrete question and the evidence needed to answer it. Do not load tools or repository regions merely because they are available.
2. Start with `rg --files`, `rg`, and narrow line slices. Source files, migrations, tests, and evidence records remain authoritative.
3. For cross-cutting architecture or ownership questions, run `npm run context:pack`. Inspect the generated map under `.codex/context-cache/`, then reopen exact source before editing or asserting behavior. The pack is disposable, compressed, secret-scanned, and token-bounded.
4. When a command result is compressed, use its local `raw_ref` to recover omitted details. Do not rerun costly work just to recover output. Treat the repository hook as inactive until the user has reviewed/trusted it and a later session actually reports compressed output.
5. Keep stable instructions and reusable procedure in this skill; keep volatile facts in source-backed Maestro knowledge records or dated evaluation evidence. Avoid growing `AGENTS.md` into a transcript.
6. Evaluate context tools on end-to-end task quality, critical-fact retention, reversibility, measured token/cost effect, privacy, maintenance, and integration fit. Publisher savings are discovery evidence, not verified savings.
7. Keep discovery, recommendation, installation, activation, invocation, and observed benefit as separate lifecycle facts. Do not imply that a catalog entry or installed dependency was used successfully.

Read [selection-matrix.md](references/selection-matrix.md) when comparing context or agent-engineering tools. Revisit a deferred tool only when its recorded trigger occurs or new independent evidence changes the tradeoff.
