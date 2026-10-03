# Phase 08 deterministic refoundation experiment

- Status: superseded as the primary semantic architecture; retained as design history
- Date: 2026-09-30
- Current authority: [ADR-004: Model-led, evidence-bound research](ADR-004-model-led-research.md)

## Context

The Phase 07 system proved that immutable evidence, heterogeneous documents, bounded live-source
leads, and versioned query snapshots can coexist. Its active product language still straddles two
different concerns, however: technology intelligence and a possible future orchestration product.
Its query interpreter also recognizes a small maintained set of landscapes directly, its source
plan is a single pass, and its `query-signal-v2` score still multiplies query relevance into the
number called Signal.

The current product needs to answer what exists, what is changing, how strongly a result matches a
need, what durable evidence supports it, and which gaps remain. Installation, invocation,
orchestration, deployment control, and agent-runtime authority are a different product boundary.
Historical Maestro records cannot be rewritten merely because the active product boundary is now
clearer.

`Signals AI` is the internal working name for this implementation. Current public products and
marks create material collision risk, so that working name is not a public rename decision.

## Experimental decisions and retained subset

ADR-004 superseded the experiment's growing deterministic query grammar, retrieval heuristics, and
seeded concept vocabulary as Maestro's primary open-world intelligence. The implementation retains
only the parts that remain useful as bounded fallback, candidate generation, exact checking,
evidence structure, and replay substrate under the model-led protocol.

1. The active product is a standalone, local-first technology and capability intelligence system.
   Search and Corpus are its permanent center. It owns query interpretation, bounded research,
   canonical knowledge, provenance, relevance judgments, intrinsic Signal, evidence confidence,
   trend, watches, and human-directed review state.
2. A future product may consume this intelligence and own orchestration or execution authority.
   Phase 08 adds no such authority and does not make an executor's ontology part of this domain.
3. Query interpretation will use a versioned, faceted concept scheme with labels and typed
   relationships. Query text may resolve concepts or propose bounded corpus-derived expansions;
   production behavior must not branch on evaluation query strings.
4. Research is an explicit two-pass-capable plan. Each plan records intent, routes, retrievers,
   budgets, reasons, coverage gaps, and a deterministic stop reason. A second pass is targeted by
   observed first-pass gaps rather than being an unconditional crawl.
5. Retrieval outputs remain independently inspectable. Lexical, concept, and source rankings are
   fused by a versioned strategy and may be reranked by a bounded, explainable feature policy.
   Reciprocal-rank fusion is the required neutral baseline; a different winner requires frozen
   evaluation evidence.
6. `Match`, intrinsic `Signal`, evidence confidence, and trend are separate values. New Signal
   policies use type-aware, cohort-aware evidence without query relevance. Phase 06 and Phase 07
   policy implementations and stored records retain their original semantics.
7. The knowledge schema is faceted rather than a single hierarchy: entity class, interface,
   service model, domain, capability, document type, and lifecycle state are independent. Typed,
   directional relationships carry their own evidence and version scope. PostgreSQL remains the
   system of record; no graph database is required.
8. Knowledge and observations are revisioned or append-only. Source absence or failure is never a
   deletion claim. Public catalog records never depend on private workspace content.
9. External content and model output remain untrusted proposals. Deterministic code owns identity,
   policy selection, budgets, persistence, authority boundaries, and verification.
10. `Signals AI` remains an internal label. The repository, packages, APIs, migration history, and
    historical policy identifiers stay under their existing public names until a human naming
    decision follows the recorded collision report.

## Reuse and rejected alternatives

- Reuse PostgreSQL full-text and trigram retrieval, Graphile Worker, TypeBox contracts, the checked
  migration runner, immutable evidence records, G6 rendering, and existing bounded adapters.
- Adapt SKOS's separation of concepts, labels, schemes, and semantic relations without requiring
  RDF or treating a knowledge-organization system as a world-fact ontology.
- Use deterministic rank fusion and evaluation before adding embeddings. A hosted vector database,
  hosted reranker, mandatory model key, whole-web crawler, or graph database is not justified by
  the established residual evidence.
- Keep probabilistic entity-linkage systems as a future option for a measured scale/ambiguity
  problem. Phase 08 starts with strong identifiers, source-scoped aliases, typed candidates, and
  reviewable ambiguity because false merges would corrupt durable history.
- Do not encode `ai`, `devops`, `ml`, `cs`, `ai models`, `AI context reduction`, or any evaluation
  answer as production semantic branches.

## Consequences

The retained subset adds forward-only schemas and versioned fallback policies while preserving
every old migration, score policy, receipt, provenance link, and replay path. It does not replace
the model-led research protocol, establish whole-web completeness, or make proxy evaluation human
gold. The internal working name can appear in this historical record; a public rename remains a
separate human and legal-risk decision.
