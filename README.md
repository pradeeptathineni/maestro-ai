# Maestro AI

Maestro v0 is a local evidence-to-decision workspace for software capabilities. It lets one
operator browse a small source-backed catalog, inspect claims and uncertainty, compare candidates
against private project constraints, safely capture a URL for review, and record an immutable
human decision receipt.

It deliberately does **not** install, authorize, invoke, or orchestrate cataloged software. No
model key is required. The narrow v0 establishes the policy, evidence, project-context, adapter,
and receipt seams that later Maestro-owned orchestration can use without making an executor's
ontology the core domain.

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
initializes Graphile Worker's schema, and imports the deterministic twelve-provider seed. It is
safe to run again: migrations are hash-checked and the seed is idempotent.

The default configuration is already safe and local. Copy `.env.example` to `.env` only when you
need to change a documented port. `MAESTRO_ALLOW_NETWORK_FETCH` defaults to `false`; in that mode,
the allowlisted GitHub adapter derives identity metadata without making a network request. Unknown
public hosts enter the supported manual-review path. Local, private, credential-bearing, non-HTTPS,
and nonstandard-port URLs are rejected and retained as safe failure receipts. Both the API bind and
configured browser origin must remain loopback-only in v0.

## Primary demonstration

1. Open **Decide** and select the seeded context-consumption need.
2. Compare the current-workflow baseline with Context Mode and GitHub Agentic Workflows.
3. Inspect the blocking unknown and hard failure before looking at project-fit preferences.
4. Open Context Mode and trace the 96% claim to its publisher source, scope, and limitations.
5. Open **Evidence** to inspect its bounded verification plan.
6. In **Consider**, submit a new GitHub repository URL twice, then submit an unknown public host.
7. Record a `trial` or `no decision` outcome and reopen its immutable, hash-verified receipt.
8. Replay current score runs with `POST /api/v1/score-runs/replay`; the historical receipt remains
   unchanged.

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

| Command                    | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run db:migrate`       | Apply forward-only reviewed migrations and verify prior hashes        |
| `npm run worker:init`      | Initialize the local Graphile Worker schema                           |
| `npm run db:seed`          | Validate and import the offline source manifest                       |
| `npm run test:provenance`  | Audit seed count, sources, attribution, scope, and score inputs       |
| `npm test`                 | Run deterministic unit and property tests                             |
| `npm run test:integration` | Rebuild `maestro_test` and exercise real persistence/API/worker paths |
| `npm run build`            | Type-check and produce the React plus Node production build           |
| `npm run test:e2e`         | Start the built local stack and run Chromium plus axe checks          |

## Production-like local run

```bash
npm run build
npm run start:test-stack
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). The API serves the built SPA from the same
origin. OpenAPI is available one layer down at `/api/documentation`.

## Architecture and boundaries

- `apps/web`: React decision workspace; five v0 surfaces only
- `apps/api`: loopback Fastify API with JSON validation, Host/Origin checks, mutation header, CSP,
  rate limits, safe problem details, structured redaction, and OTel-compatible spans
- `apps/worker`: Graphile Worker intake adapter and transactional-outbox dispatcher
- `packages/domain`: pure identity, URL, gate, decision-receipt, and future adapter contracts
- `packages/scoring`: pure versioned consideration, project-fit, and verification policies
- `packages/db`: Drizzle declarations, checked migrations, and explicit repositories
- `packages/seed`: offline reviewed manifest, audit, and idempotent importer

PostgreSQL schemas enforce the trust boundary: `catalog` contains shareable reviewed knowledge,
`workspace` contains private local project context, and `ops` contains intake, job, audit, and
migration records. The public catalog repository never joins to `workspace`; an integration canary
test proves the separation.

The following remain intentionally absent: arbitrary crawling, semantic/vector search, model
routing, agent or tool execution, install/configure/permission endpoints, sandboxing, continuous
discovery, CI/CD or deployment control, multi-user hosting, and broader SDLC/portfolio surfaces.

See [ADR-001](docs/architecture/ADR-001-v0-foundation.md), the
[schema contract](docs/architecture/schema.md), and the adjacent authoritative planning workspace
for the complete product decisions.

## Troubleshooting

- If `db:init` cannot connect, run `docker compose ps` and wait for PostgreSQL to report `healthy`.
- If a URL remains queued, confirm `npm run dev:worker` is running; readiness reports worker state.
- If dependency lifecycle scripts are blocked by local npm policy, do not globally approve them for
  Maestro. The checked build and tests are the authority for this slice.
- Stop local services with `docker compose stop`. The named volume preserves development data.
