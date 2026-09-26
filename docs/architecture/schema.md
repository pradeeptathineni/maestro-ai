# Schema contract

- `catalog`: public provider identities, versioned capabilities/domains, sources, immutable
  observations/claims/evidence, score runs, and scoped verification assessments.
- `workspace`: local private workspace, stable projects, immutable context snapshots, needs,
  constraints, candidates, fit assessments, recommendations, and immutable decisions.
- `ops`: quarantined URL intake, append-only state events, transactional outbox, finalizable but
  non-deletable worker attempt receipts, audit events, and migration bookkeeping.

The executable contract is the ordered, hash-checked set under
[`packages/db/migrations/`](../../packages/db/migrations/). Applied migrations are never edited;
corrections are forward-only. Migration `0005` restores worker finalization after real worker
verification showed that attempts must leave `started`; migration `0006` then limits this to one
validated terminal transition. Migration `0007` binds provider versions to their provider, binds
fit and decision rows to the need's exact project context, validates candidate snapshot hashes,
and seals score policies, constraints, candidates, and candidate components against historical
semantic rewrite. Deletion and completed-attempt mutation remain forbidden. A later attempt
explicitly finalizes any stranded in-flight predecessor as interrupted before retrying, while a
session advisory lock prevents two live processors from racing on the same intake.
Migration `0008` gives normalized strong identities a workspace-scoped unique boundary so URL
variants and concurrent submissions cannot create duplicate intake histories.

Drizzle declarations mirror queryable concepts but do not replace reviewed SQL. Startup never uses
schema push. Corrections to immutable evidence, score, context, and decision records require a new
revision or explicit supersession.
