# Maestro AI

> **Product direction:** the standalone technology-intelligence product is being developed under
> the working title **Signals AI**. The repository and packages intentionally retain their Maestro
> names until the recorded naming-collision gate receives a human decision.

The current product is a local-first technology search and evidence-to-decision workspace. Search starts
with a useful offline index, fans out to every source the operator has enabled, and gives every
returned item a query-specific signal estimate with confidence, missing information, and source
state shown separately. List, map, detail, compare, and export share one immutable local snapshot;
live source results remain visibly preliminary and are saved into a separate research corpus. A
reviewed admission—not collection alone—moves a lead into the indexed knowledge layer.

It does **not** install, authorize, invoke, or orchestrate cataloged software. No model key is
required. The narrow system establishes policy, evidence, project-context, adapter, and receipt
seams without making an executor's ontology the core domain. A future product may consume this
intelligence, but orchestration and execution are deliberately outside this repository's current
scope.

## Prerequisites

- Node.js `24.19.x` and npm `12.1.x` (see `.nvmrc` and `package.json`)
- Docker Desktop or another local Docker runtime with Compose
- ports `4310`, `5173`, and `54329` available on loopback

No hosted database, external account, API key, or live seed fetch is needed.

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

The default configuration is safe and local: every Phase 06 source/model adapter starts disabled,
and indexed search needs no model, key, network, or automatic model download. When a source adapter
is enabled, pressing Search sends only the public search text to that source and shows its scored
leads separately from the immutable local result set. Copy
`.env.example` to `.env` only when changing a documented port. `MAESTRO_ALLOW_NETWORK_FETCH=false`
also keeps the original Consider/refresh metadata path offline. Unknown public hosts enter manual
review; local, private, credential-bearing, non-HTTPS, and nonstandard-port public URLs are rejected
as safe failure receipts. Both the API bind and browser origin remain loopback-only in v0.

## Primary demonstration

1. Open **Search**, ask for `ai context reduction github`, and inspect the result count, signal,
   confidence, caveat, and `query-signal-v1` explanation.
2. Switch between list and the bounded capability map, open a detail, compare two items, and save a
   shortlist to the seeded local project. The query stays out of the URL.
3. Open **Corpus** to browse saved indexed records and source leads, or enter a need to score every
   matching record under the same query policy used by Search.
4. Open **Workspace** to create or revise a project context and configure source adapters. Enabled
   source adapters run when the operator presses Search; local semantic assistance remains separate.
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

- `apps/web`: React Explorer plus decision, intake, evidence, and workspace surfaces
- `apps/api`: loopback Fastify API with JSON validation, Host/Origin checks, mutation header, CSP,
  rate limits, safe problem details, structured redaction, and OTel-compatible spans
- `apps/worker`: Graphile Worker intake adapter and transactional-outbox dispatcher
- `packages/domain`: pure identity, URL, query/bundle, gate, and decision-receipt contracts
- `packages/scoring`: pure versioned intrinsic Signal, Match-adjacent confidence/trend,
  historical query-signal replay, project-fit, and verification policies
- `packages/db`: Drizzle declarations, checked migrations, and explicit repositories
- `packages/seed`: offline reviewed manifest, audit, and idempotent importer

PostgreSQL schemas enforce the trust boundary: `catalog` contains shareable reviewed knowledge,
`workspace` contains private local project context, and `ops` contains intake, job, audit, and
migration records. The public catalog repository never joins to `workspace`; an integration canary
test proves the separation.

The following remain intentionally absent: arbitrary crawling, vector/embedding retrieval, cloud or
gateway model fallback, agent/tool execution, candidate install/permission endpoints, sandboxing,
CI/CD or deployment control, multi-user hosting, and broader SDLC/portfolio surfaces. A configured
loopback model can create an attributed review-only interpretation proposal; it cannot alter a
snapshot, score, policy, or authority. The local index is a cache and evidence substrate, not a
claim to contain all technology knowledge.

See [ADR-001](docs/architecture/ADR-001-v0-foundation.md),
[ADR-002](docs/architecture/ADR-002-phase-06-intelligence-explorer.md), the
[Phase 08 refoundation ADR](docs/architecture/ADR-004-intelligence-product-refoundation.md), the
[living architecture](ARCHITECTURE.md), the [schema contract](docs/architecture/schema.md), and the
adjacent authoritative planning workspace for the complete product decisions.

## Troubleshooting

- If `db:init` cannot connect, run `docker compose ps` and wait for PostgreSQL to report `healthy`.
- If a URL remains queued, confirm `npm run dev:worker` is running; readiness reports worker state.
- If dependency lifecycle scripts are blocked by local npm policy, do not globally approve them for
  Maestro. The checked build and tests are the authority for this slice.
- Stop local services with `docker compose stop`. The named volume preserves development data.
