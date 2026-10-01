# Maestro AI

Maestro is a local-first research system for finding high-signal existing knowledge that can help a
project. **Search** investigates enabled public sources for a live need. **Corpus** searches durable,
admitted, refreshable knowledge. Both use one evidence-bound research protocol for interpretation,
refinement, filtering, and organization while keeping their evidence universes and user experience
distinct.

The strongest path is model-led: one explicitly configured structured-output model proposes
bounded source searches, assesses evidence gaps, and organizes cited findings. Deterministic code
controls privacy, tools, budgets, identity, provenance, admission, and replay. The preserved Phase
06/07 deterministic search remains a transparent no-model fallback and evaluation comparator, not
an expanding word-list substitute for open-world understanding.

It does **not** install, authorize, invoke, or orchestrate cataloged software. No
model key is required. The narrow v0 establishes the policy, evidence, project-context, adapter,
and receipt seams that later Maestro-owned orchestration can use without making an executor's
ontology the core domain.

## Prerequisites

- Node.js `24.19.x` and npm `12.1.x` (see `.nvmrc` and `package.json`)
- Docker Desktop or another local Docker runtime with Compose
- ports `4310`, `5173`, and `54329` available on loopback

No hosted database, external account, API key, model, or live seed fetch is needed for the fallback
and local Corpus.

## Local setup

```bash
npm ci
docker compose up -d
npm run db:init
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). `db:init` applies checked SQL migrations,
initializes Graphile Worker's schema, and imports the deterministic 61-item search seed. Twelve
items have reviewed baseline evidence; the other 49 retain their proposed source-review state but
still receive conservative numeric signal estimates. Initialization is safe to run again:
migrations are hash-checked and the seed is idempotent.

The default configuration is safe and local: every source/model adapter starts disabled, and
indexed search needs no model, key, network, or automatic model download. When an explicit
loopback `local_semantic` model and public source adapters are enabled, Search runs
`research-skill-v1`; only public query/evidence fields cross those boundaries. Otherwise it uses
the preserved deterministic path. Copy
`.env.example` to `.env` only when changing a documented port. `MAESTRO_ALLOW_NETWORK_FETCH=false`
also keeps the original Consider/refresh metadata path offline. Unknown public hosts enter manual
review; local, private, credential-bearing, non-HTTPS, and nonstandard-port public URLs are rejected
as safe failure receipts. Both the API bind and browser origin remain loopback-only in v0.

## Primary demonstration

1. Open **Search**, ask a real project question, and inspect why each result is relevant, which
   evidence it cites, what remains uncertain, and whether the answer came from live research or the
   deterministic fallback.
2. Switch between list and the bounded capability map, open a detail, compare two items, and save a
   shortlist to the seeded local project. The query stays out of the URL.
3. Open **Corpus** to browse admitted indexed records or research them through the same model
   proposal/synthesis contract without making network calls. Raw live leads remain outside Corpus
   until explicit admission.
4. Open **Workspace** to create or revise private project context and configure source adapters.
   Project context is not disclosed to the model or public sources in this phase.
5. Open **Decide**, compare provider/composition/status-quo/build/defer options, and inspect hard
   gates before preference fit.
6. Record a `trial` or `no decision` outcome and reopen its immutable, hash-verified receipt.

## Verification

With Docker running:

```bash
npm run verify
```

The gate checks formatting, lint, strict types, unit/property tests, a fresh-schema real-PostgreSQL
integration suite, the production build, deterministic provenance, dependency advisories, and
Playwright/axe browser tests. Integration tests create and rebuild only the dedicated
`maestro_test` database; they do not reset the development `maestro` database.

Useful individual commands:

| Command                     | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `npm run db:migrate`        | Apply forward-only reviewed migrations and verify prior hashes               |
| `npm run worker:init`       | Initialize the local Graphile Worker schema                                  |
| `npm run db:seed`           | Validate and import the offline source manifest                              |
| `npm run test:provenance`   | Audit seed count, sources, attribution, scope, and score inputs              |
| `npm test`                  | Run deterministic unit and property tests                                    |
| `npm run test:integration`  | Rebuild the explicit test database and exercise persistence/API/worker paths |
| `npm run build`             | Type-check and produce the React plus Node production build                  |
| `npm run test:e2e`          | Start the built local stack and run Chromium plus axe checks                 |
| `npm run eval:phase06`      | Run the frozen 50-query proxy retrieval/signal evaluation                    |
| `npm run benchmark:phase06` | Run the disposable 10k-row cached-query benchmark                            |
| `npm run context:pack`      | Create a secret-scanned, bounded disposable repository map                   |

## Production-like local run

```bash
npm run build
npm run start:test-stack
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). The API serves the built SPA from the same
origin. OpenAPI is available one layer down at `/api/documentation`.

## Architecture and boundaries

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for current intent, boundaries, the model/deterministic
split, and reused prior art.

- `apps/web`: React Explorer plus decision, intake, evidence, and workspace surfaces
- `apps/api`: loopback Fastify API with JSON validation, Host/Origin checks, mutation header, CSP,
  rate limits, safe problem details, structured redaction, and OTel-compatible spans
- `apps/worker`: Graphile Worker intake adapter and transactional-outbox dispatcher
- `packages/domain`: pure identity, research protocol, URL, query/bundle, gate, and receipt contracts
- `packages/scoring`: pure versioned consideration, query-signal, project-fit, and verification policies
- `packages/db`: Drizzle declarations, checked migrations, and explicit repositories
- `packages/seed`: offline reviewed manifest, audit, and idempotent importer

PostgreSQL schemas enforce the trust boundary: `catalog` contains shareable reviewed knowledge,
`workspace` contains private local project context, and `ops` contains intake, job, audit, and
migration records. The public catalog repository never joins to `workspace`; an integration canary
test proves the separation.

The following remain intentionally absent: arbitrary crawling, cloud or gateway model fallback,
general agent/tool execution, candidate install/permission endpoints, sandboxing, CI/CD or
deployment control, multi-user hosting, and broader SDLC/portfolio surfaces. A configured loopback
model can propose bounded research actions and evidence organization; it cannot change policy,
authority, admission, or private context. The local index is an evidence substrate, not a claim to
contain all useful knowledge.

See [ADR-001](docs/architecture/ADR-001-v0-foundation.md),
[ADR-004](docs/architecture/ADR-004-model-led-research.md), the
[schema contract](docs/architecture/schema.md), and the adjacent authoritative planning workspace
for the complete product decisions.

## Troubleshooting

- If `db:init` cannot connect, run `docker compose ps` and wait for PostgreSQL to report `healthy`.
- If a URL remains queued, confirm `npm run dev:worker` is running; readiness reports worker state.
- If dependency lifecycle scripts are blocked by local npm policy, do not globally approve them for
  Maestro. The checked build and tests are the authority for this slice.
- Stop local services with `docker compose stop`. The named volume preserves development data.
