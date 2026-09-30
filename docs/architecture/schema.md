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
semantic-adapter configuration. Phase 07 migration `0015` adds first-class knowledge documents,
query plans, heterogeneous document results, source-route state, and restart-safe watch leases.

Phase 08 migration `0016` adds a compatibility layer rather than replacing those records:

- `facet_definitions`, `concept_schemes`, `concepts`, `concept_labels`, and `concept_relations`
  represent versioned entity-class, interface, service-model, domain, capability, and document-type
  semantics;
- `knowledge_entities` gives existing providers and documents stable canonical subject identities;
- immutable `knowledge_entity_revisions` and `knowledge_document_revisions` preserve current and
  future corrections without rewriting the Phase 07 rows;
- `entity_facet_assignments` binds orthogonal, evidence-qualified facets to subjects; and
- `knowledge_relationships` projects old provider/document links into typed, directional,
  evidence-bearing, revision-scoped relationships.

Compatibility triggers project future writes through the historical provider/document APIs into
the new layer. They do not reverse-sync or change old score, query, receipt, or provenance meaning.

Migration `0017` adds general entity/document/interface alternate labels and service-operation
concepts, then makes research-plan budgets, stop policy, coverage assessment, planned pass count,
and stop reason independently queryable. Historical Phase 07 plans retain `NULL` for fields that
were not captured by their policy; their original JSON and plan hash remain unchanged.

Migration `0018` adds immutable retrieval lineage without changing a historical result set:

- `query_retrieval_runs` records bounded local retriever/pass execution and disclosure limits;
- `query_retrieval_hits` records native rank, score, matched terms, concepts, and candidate source;
- `query_candidate_fusions` preserves both compared fusion rankings, structured rerank outputs,
  entity-resolution evidence, and the selected policy for every frozen candidate; and
- nullable result-set metadata records the candidate-pool hash, selected fusion/rerank policy,
  pass count, stop reason, and coverage assessment. Pre-Phase-08 result sets retain `NULL` for facts
  their original policy did not capture.

The default Phase 08 policy is normalized weighted fusion; reciprocal-rank fusion remains persisted
as the comparison baseline over the identical frozen pool. Neither policy changes intrinsic Signal
or grants discovery, installation, or execution authority.

Migration `0019` adds immutable `intrinsic_signal_runs` for the query-independent
`intrinsic-signal-v3` policy. Each receipt binds one canonical entity revision to type-aware,
cohort-normalized inputs, evidence-confidence detail, an explicit trend window, and the exact
policy/input hash. New query result items reference that public catalog receipt while the historical
`query_signal_runs` and embedded document score fields remain intact for v1/v2 replay. Match stays
in query-scoped retrieval lineage with a score, band, reasons, and concept path; it is never folded
into intrinsic Signal. Pre-`0019` query results retain their original policy and nullable intrinsic
reference.

The readiness gate checks the ordered repository migrations; catalog cardinality remains diagnostic
data rather than readiness.

Drizzle declarations mirror base-table contracts but do not replace reviewed SQL; derived current
views remain explicit migrations and raw repository queries. Startup never uses schema push.
Corrections to immutable evidence, score, context, and decision records require a new revision or
explicit supersession.

Migration `0020` records append-only source reliability, metric history, corroboration, refresh
policy, and typed concept/query/entity watches. Query deletion disables its watches in the same
transaction; refresh attempts retain their target, lease, source-attempt, change, and stop-reason
lineage.

Migration `0021` binds predecessor and supersession foreign keys to their logical owner. A revision
cannot cite a row from another entity, document, source, query session, provider, facet, or
relationship subject merely because the referenced UUID exists. Source-reliability and
corroboration writers also serialize appends on the logical history key so concurrent writes form
one lineage.

Migration `0022` adds indexed current-state projections over immutable histories. The current
concept-scheme view selects the newest active version per stable scheme key. Current facet and
relationship views honor validity windows and exclude rows with an effective append-only
successor. Historical base rows remain directly queryable and unchanged; current search and filter
paths use the projections so a correction does not leave both predecessor and successor active.
