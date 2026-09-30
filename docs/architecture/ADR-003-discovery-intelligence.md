# ADR-003: Discovery intelligence and durable heterogeneous knowledge

- Status: accepted for Phase 07 implementation
- Date: 2026-09-30
- Supersedes: no historical ADR; extends ADR-001 and ADR-002

## Context

Phase 06 proved immutable query snapshots, bounded source adapters, conservative numeric Signal,
and a local research Corpus. It also exposed structural limits: the maintained vocabulary was
mostly AI coding tooling, every connected source received the same string, result order allowed
weakly related high-value records to outrank direct matches, articles were represented only as
sources for provider-shaped records, and scheduled refresh depended on already-enqueued work.

Phase 07 must support broad landscapes such as `ai`, `devops`, `ml`, and `cs`; typed discovery
such as `ai models`; and narrow mechanism queries such as `AI context reduction`. Public source
queries remain opt-in and bounded. Catalog records remain public/shareable, workspace query state
remains private, and operational attempts remain in `ops`. Discovery never grants installation,
invocation, deployment, or other execution authority.

## Decision

1. `deterministic-v2` interprets each query into one visible intent mode, corrected canonical
   concepts, typed targets, landscape facets, bounded expansions, and missing-context warnings.
   It uses token/phrase boundaries; short aliases such as `ml` and `cs` never match substrings.
2. `source-plan-v1` preserves one coherent intent while emitting source-specific variants and a
   reasoned route state. Planned, skipped, unsupported, denied, failed, and completed routes are
   durable. Project context and other private workspace text are never inputs to a public route.
3. Search candidates are heterogeneous. Implementations/providers continue to use immutable
   knowledge projections. Documents are first-class immutable records with typed `about`,
   `explains`, `evaluates`, or `specifies` links; they are not fake installable providers.
4. Ranking separates match from supported attention. Direct lexical or structured matches sort
   before partial or adjacent matches. `query-signal-v2` uses type-profiled value dimensions and
   preserves a numeric estimate for every non-excluded result; evidence coverage and review state
   visibly qualify rather than suppress that number. Phase 06 `query-signal-v1` records and replay
   retain their original meaning.
5. Result diversification is deterministic and bounded by intent facets and kinds. It prevents a
   broad landscape from being filled by one implementation kind but never promotes an incidental
   item above a direct match merely to create variety.
6. Live acquisition is a lead generator. Safe identity and publisher-scope metadata may be
   admitted automatically as proposed knowledge under a recorded policy. Ambiguous identity,
   consequential claims, conflicts, and project-fit assertions require review.
7. Watches are restart-recoverable schedules with database due times, leases, bounded backoff,
   idempotent operation keys, pause/disable controls, and deletion-safe source health. A failed or
   missing source is never evidence that a subject was deleted or unchanged.
8. The selected interface is a research workbench with an atlas as a synchronized view: compact
   populated header, visible landscape facets, relevance/evidence cues, docked desktop inspector,
   mobile detail flow, and focused typed relationships. Spatial distance carries no evidentiary
   meaning.

## Reuse and rejected alternatives

- Retain PostgreSQL full-text/trigram indexes, Graphile Worker, the existing append-only evidence
  spine, G6 renderer, TypeBox boundaries, and the existing local semantic adapter contract.
- Add no hosted vector database, graph database, cloud model fallback, crawler, browser scraper,
  or autonomous execution runtime. The measured misses are addressable first with structured
  concepts, token-safe lexical retrieval, source-specific planning, and a larger source-backed
  corpus. The optional loopback semantic path remains measurable and explicit, not silently
  emulated by a cloud service.
- Do not encode expected answers per benchmark query. Query rules describe concepts and types;
  fixtures and adjudication remain separate.

## Consequences

Phase 07 adds forward-only schema, functional runtime names with compatibility aliases, and new
evaluation evidence. Broader coverage is finite and source-dependent, not an all-internet claim.
Document scoring is about query usefulness and evidence support, not installability. Live source
availability, independent human relevance adjudication, and aesthetic acceptance remain separate
readiness axes.
