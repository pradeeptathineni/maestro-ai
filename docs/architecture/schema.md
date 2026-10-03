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

Phase 06 adds only intelligence-explorer records to these same schemas: public display and search
projections plus relational evidence/score lineage in `catalog`; private query/result snapshots,
project authoring, shortlists, watches and portable decision inputs in `workspace`; and bounded
adapter configuration, discovery budgets/attempts and change notices in `ops`. It does not add the
future general run/step/agent/grant/deployment schema. The numbered forward migration is the exact
executable contract; this summary must not be used to infer a table that is not present.

The Phase 06 contract is split across migrations `0009`–`0014`: integrity/authoring, explorer
snapshots, bounded discovery, query privacy controls, query-value projection cache, and optional
semantic-adapter configuration. Phase 07 migration `0015` adds query-first source planning and
durable discovery continuity. Phase 08 migration `0016` adds bounded research runs, attributable
model proposals, source-action links, leases, and terminal receipts. Migration `0017` binds every
research acquisition to its declared result limit and hardens research-run history and state
transitions. Migration `0018` prevents late proposals, source operations, source links, or events
from extending a terminal research history. Migration `0019` requires every research source
operation to match the active run's exact workspace, query session, and immutable result-set
snapshot. Migration `0020_research_child_serialization.sql` serializes research child inserts and
source-operation updates with parent finalization, so recovery cannot be crossed by a late evidence
or attempt commit.

The additive intelligence substrate uses parallel, fully named Phase 08 migrations; numeric
prefixes alone are not identifiers. `0016_faceted_knowledge.sql` through
`0023_ai_development_tools_domain.sql` add versioned facets and relationships, two-pass retrieval
lineage, query-independent intrinsic Signal, evidence confidence, source reliability,
corroboration, append-only current views, and a current-scheme bridge for retained entities.
`0024_shared_match_and_discovery_links.sql` deliberately reuses the model-led
`ops.discovery_operation_candidates` table and only admits the shared Match policy version.
`0025_typed_signal_normalization.sql`, `0026_evidence_bound_corroboration.sql`, and
`0028_typed_discovery_admission.sql` add typed normalization, exact evidence bindings, and atomic
human-reviewed admission as either an implementation or a document. The discarded duplicate
research-run and operation-lease migrations were never released and are not part of the contract.
`0030_precomputed_search_vectors.sql` stores the exact existing full-text expressions so bounded
candidate ranking does not re-tokenize every matching row. `0031_corroboration_entity_binding.sql`
requires every corroboration item to support the exact applicable entity revision, predicate, and
scope at the database boundary.

The readiness gate requires all 34 repository migration files by exact filename; catalog
cardinality is diagnostic data, not readiness.

Drizzle declarations mirror queryable concepts but do not replace reviewed SQL. Startup never uses
schema push. Corrections to immutable evidence, score, context, and decision records require a new
revision or explicit supersession.
