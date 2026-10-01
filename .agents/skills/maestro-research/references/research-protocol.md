# Maestro research protocol

Use this reference only when driving or extending the local repository/service.

## Two modes, one judgment contract

- `search` lets the model propose queries only for currently enabled public source adapters.
- `corpus` retrieves only admitted indexed records and never calls a live source.

Both modes use `research-skill-v1` and three structured proposal types:

1. `plan`: interpretation, research questions, allowed-source actions, and stop tests.
2. `refinement`: evidence-bound assessment, material gaps, and either a bounded next action or a stop reason.
3. `synthesis`: a sufficient/insufficient context judgment. Sufficient output has ordered and
   grouped candidate IDs, relevance reasons, uncertainty, and exact item plus summary citations;
   insufficient output abstains without findings and records limitations.

The host, not the model, validates schemas and IDs, clamps budgets, executes adapters, enforces privacy, stores hashes and receipts, and controls explicit Search-to-Corpus admission. Model output is always an attributable proposal. A historical receipt can be verified and rendered again; a fresh model call is not claimed to be deterministic.

The authoritative schemas and validators are in `packages/domain/src/research.ts`. Persistence is in `packages/db/migrations/0016_research_skill_v1.sql` and `packages/db/src/research-repository.ts`.

## Local API sequence

1. Create a query session with `POST /api/v1/explorer/sessions`.
2. Start an explicit run with `POST /api/v1/explorer/sessions/:id/research-runs` and `{ "mode": "search" | "corpus", "idempotencyKey": "..." }`. A Search session created with `searchConnectedSources: true` also attempts this path automatically.
3. Poll `GET /api/v1/research/runs/:id` until terminal.
4. Inspect proposal validation receipts, distinct source outcomes, final receipt, context
   assessment, limitations, and exact cited IDs. A `complete` state proves protocol completion, not
   human usefulness.
5. If a Search run fails, `POST /api/v1/research/runs/:id/fallback` starts the idempotent
   deterministic source plan against the run's frozen result set. This does not convert acquired
   leads into model conclusions or Corpus knowledge.

The configured `local_semantic` adapter is an explicit loopback OpenAI-compatible structured-output endpoint. There is no cloud fallback, automatic model download, model router, or general tool authority. When it is unavailable or budget-denied, the existing deterministic Search or Corpus path remains the declared fallback.

## Evaluation use

Run model-led and deterministic paths over the same frozen candidate/source budget. Compare:

- human relevance and coverage judgments;
- must-find recall when the must-find list was independently created;
- citation correctness and claim support;
- useful grouping and explanation;
- important omissions and false inclusions;
- repeated-run stability;
- calls, tokens, elapsed time, and attributable cost.

Do not tune production prompts or semantics to evaluation query strings or expected answers. Freeze the implementation before an independent unseen-query challenge.
