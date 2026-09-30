# ADR-002: bounded Phase 06 Intelligence Explorer

Status: accepted and amended by human direction on 2026-09-29, implementing planning decisions D-027 through D-031.

Phase 06 extends the reviewed v0 modular monolith with a search-first intelligence surface and the minimum authoring/durability paths needed to use it honestly. The product identity is broad, evidence-aware technology search for a concrete need—not an attempt to maintain a complete copy of all technology knowledge. The local index is an offline cache and evidence substrate. Configured source adapters widen a user-initiated search in real time. A user can inspect a stable list/map/detail/compare snapshot, review separately scored live source results, save items to a private project/context, furnish alternatives, and record a decision. This does not authorize installation or execution of cataloged capabilities.

The implementation retains PostgreSQL lexical/trigram retrieval as the always-available baseline. Query interpretation uses a versioned deterministic vocabulary; optional semantic proposals run only through an explicitly configured loopback endpoint and never own IDs, gates, scoring, publication or review. GitHub and official MCP Registry readers plus an optional direct SearXNG reader are bounded adapters, disabled by default. Once enabled, the Search action queues all configured source readers with only the public query. Offline search remains useful without a model, credentials or network.

The product has two related but distinct read models. **Search** performs a query-scoped research
run over the immutable local result snapshot plus enabled source operations. **Corpus** browses the
durable output of that work: reviewed/proposed indexed projections and preliminary attributed
source leads. Both paths reuse identity normalization, source provenance, deterministic query
interpretation and `query-signal-v1`; they do not duplicate an independent crawler or ranking
stack. Source candidates are retained automatically, but collection never silently establishes a
claim, evidence review or publication state. Admission remains an explicit evidence-producing
transition.

Each Search action queues one operation for every enabled external source. External operations
share an atomic ceiling of 50 reserved calls per database day and retain smaller per-source
ceilings; there is no guessed explore/deepen quota split. Local semantic assistance has a separate
configured ceiling. Reservations, attempts, consumed calls, failures, and cancellation uncertainty
are recorded rather than hidden behind SDK retries.

`query-signal-v1` is separate from `consideration-v1` and project fit. It binds an ordinal query relevance assessment to evidence-aware reuse-value inputs under an immutable result-set revision. It is not a probability or security grade. Every non-excluded search result receives a numeric estimate. Coverage below 0.45 is labeled low confidence, and proposed/model-derived inputs are labeled preliminary; neither review state nor sparse evidence suppresses the estimate. Missing values still use declared priors and the uncertainty deduction. Hard project requirements remain independent gates.

G6 is a lazy-loaded renderer for a server-produced graph projection. It does not define relationships or replace relational storage. Every edge carries a type, scope and provenance/review state, and the same result-set revision has a keyboard-accessible DOM alternative.

New truth claims and writers require material display snapshots/revisions, relational evidence bindings, append-only score lineage and an offline-verifiable export. Existing v0 receipt canonicalization and policy replay remain supported. Public catalog records cannot reference private queries, contexts or outcomes.

The following remain out of scope: arbitrary capability execution, model routing/gateway ownership, multi-agent workflows, browser crawling, automatic model downloads, pgvector without a successful measured experiment, hosted multi-tenancy, deployment/CI control, and future general run/step/grant schemas.
