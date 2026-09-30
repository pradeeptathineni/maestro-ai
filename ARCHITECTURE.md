# Architecture

> Living orientation for the current technology-intelligence product. ADRs preserve historical
> decisions and rationale; the adjacent private planning workspace preserves phase evidence.

## Product intent

The product is a local-first technology and capability intelligence system, currently developed
under the working title **Signals AI**. It discovers, organizes, evaluates, refreshes, and explains
tools, standards, practices, models, publications, and other knowledge without granting them
installation, invocation, deployment, or orchestration authority. The public repository and package
remain named Maestro until the separate naming decision is resolved.

## Core intelligence loop

```text
query
 -> interpret against versioned concepts and facets
 -> compile a budgeted research plan
 -> retrieve independently by route
 -> resolve identities and fuse rankings
 -> rerank and organize with visible reasons
 -> inspect coverage and run a bounded second pass when justified
 -> enrich with source-backed observations
 -> calculate Match / intrinsic Signal / evidence confidence / trend
 -> expose a Search snapshot and durable Corpus knowledge
 -> refresh, observe change, and preserve revisions
```

## Major components and ownership

| Component           | Owns                                                                                   | Does not own                                     |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/web`          | Accessible Search, Corpus, detail, compare, relationship, and review experiences       | Ranking policy, evidence truth, authority        |
| `apps/api`          | Loopback HTTP boundary, contract validation, safe errors, origin and mutation controls | Domain-policy invention, external execution      |
| `apps/worker`       | Durable bounded adapter and refresh work with one retry owner                          | Open-ended crawling, installation, orchestration |
| `packages/domain`   | Identity, privacy, concepts, research plans, query and lifecycle contracts             | Database access, UI state, network I/O           |
| `packages/scoring`  | Pure versioned Match, Signal, confidence, trend, fit, and historical replay policies   | Persistence, source access, presentation         |
| `packages/db`       | Checked forward migrations and explicit repositories across trust schemas              | Hidden joins across privacy boundaries           |
| `packages/adapters` | Bounded source-specific acquisition and normalization of untrusted responses           | Admission, authority, final truth                |
| `packages/seed`     | Deterministic source-backed bootstrap knowledge                                        | CI-time live fetches or private workspace data   |

## Knowledge model

Canonical subjects have stable identities and one entity class. Orthogonal, versioned facets describe
interfaces, service models, domains, capabilities, and document types. Concept schemes provide
preferred, alternate, and hidden labels plus broader, narrower, and related links. Knowledge
relationships are typed, directional, evidence-bearing, and scoped to revisions. Observations keep
source, retrieval, time, rights, and raw-payload provenance separate from reviewed assertions.

Provider projections and knowledge documents from earlier phases remain valid compatibility views.
Corrections create revisions or append-only successors; they never rewrite accepted history.

## Search and research flow

The interpreter classifies exact, typed, broad, problem, temporal, constrained, and ambiguous intent.
It resolves labels through the selected concept-scheme version, uses bounded relationship expansion,
and may propose corpus-derived phrases without treating proposals as accepted concepts. A planner
selects source routes and retrievers with per-route and total budgets. First-pass rankings are kept
separate, deduplicated by strong identifiers and reviewable aliases, then fused. Coverage analysis
may request one targeted second pass. Every plan ends with a durable stop reason such as sufficient
coverage, exhausted budget, no useful expansion, source unavailable, or cancelled.

No evaluation query has a dedicated production branch. New domains must work through the same label,
facet, corpus-statistics, and source-routing mechanisms.

Small local catalogs are assessed exhaustively. Above the measured catalog threshold, PostgreSQL
first selects a bounded candidate window from exact identities, resolved concepts, aliases,
capabilities, and full-text matches; the unchanged deterministic retrievers, fusion, reranker, and
receipt writers then operate on that window. The query interpretation stage uses the same
outside-in rule for entity labels while retaining the full catalog count. Candidate-selection
policy, threshold, limits, and selected counts are recorded in result diagnostics. This hook is
downstream of immutable source observations and knowledge revisions, so performance filtering does
not discard or rewrite original evidence.

## Match, Signal, evidence, and trend

- **Match** is query-dependent relevance: why this entity or document answers this query.
- **Signal** is query-independent supported importance within an entity-type and time cohort.
- **Evidence confidence** describes support coverage, independence, freshness, and unresolved
  conflict; missing evidence remains visible rather than becoming zero.
- **Trend** describes direction and rate over named observation windows. It is not lifetime
  popularity and a social spike is not corroboration.
- **Project fit** is private workspace policy and remains separate from all four public values.

Historical `query-signal-v1` and `query-signal-v2` records preserve their original meanings.

## Source and refresh model

Adapters declare identity, supported routes, rights notes, credentials, safety policy, budgets, and
normalization behavior. Network access is explicit and bounded. Research leads remain provisional
until admitted under a recorded policy. Source health is an observation, not evidence that a subject
is absent. Watches target concepts, queries, or entities; refresh cadence is type-sensitive, leased,
restart-recoverable, and recorded with source attempts and stop reasons. Provider watches may run a
bounded source adapter; concept, query, and canonical-entity watches compare deterministic local
corpus snapshots, with query watches first rebuilding their immutable result snapshot. Lease tokens
are compare-and-set completion guards, so a stale worker cannot overwrite a newer refresh. Deleting
a private query disables its watches in the same transaction.

## Security and privacy boundaries

`catalog` is public/shareable knowledge, `workspace` is private local context, and `ops` is
operational history. Public records never depend on workspace content. Only public query text can
leave the process through an enabled adapter. Credentials, private hosts, unsafe redirects, and raw
untrusted text are contained at adapter and serialization boundaries. External text and model output
cannot select policies, mutate accepted records, grant permissions, or trigger software execution.

## Reuse register

| Responsibility        | Owned semantics                                    | Reused prior art/system                                    | Why                                                | Current boundary                          | Revisit trigger                                |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Concept organization  | Scheme versions, accepted concepts, product facets | W3C SKOS data model                                        | Mature label/relation distinctions                 | PostgreSQL rows; no RDF runtime           | Cross-dataset interchange becomes material     |
| Lexical retrieval     | Product fields and match reasons                   | PostgreSQL FTS + `pg_trgm`                                 | Already measured, local, explainable               | No embedding assumption                   | Frozen unseen-domain residual remains material |
| Rank fusion           | Strategy/version and explanations                  | Reciprocal Rank Fusion; normalized score fusion comparator | Robust unsupervised baseline and explicit ablation | Deterministic local functions             | Labeled evidence supports learned fusion       |
| Reranking             | Product feature policy and containment             | Retrieve-then-rerank architecture                          | Separates candidate recall from ordering           | Explainable local features first          | A local model wins bounded evaluation          |
| Entity reconciliation | Canonical IDs, alias evidence, review state        | OpenRefine reconciliation concepts                         | Strong IDs and reviewable ambiguity                | No automatic uncertain merge              | Scale/labels justify probabilistic linkage     |
| OSS metadata          | Admission and provenance policy                    | GitHub, deps.dev, ecosyste.ms where enabled                | Structured source facts beat scraping              | Bounded adapters; licensing retained      | Coverage/value study supports another source   |
| Research metadata     | Product document semantics                         | Crossref, OpenAlex/Semantic Scholar candidates             | Structured identifiers and citations               | Candidate adapters, not blanket ingestion | Live study and rights review pass              |
| Durable work          | Retry, leases, operation keys                      | Graphile Worker                                            | Existing transactional local queue                 | Bounded research/refresh only             | Different workload is measured                 |
| Relationship view     | Evidence semantics and accessible alternative      | G6 renderer                                                | Existing bounded visualization                     | Graph is a view, not storage/truth        | Usability evidence supports replacement        |

## Evaluation gates

Policies are frozen before challenge evaluation. Development judgments, independently reviewed
gold-candidate judgments, an unseen-domain challenge, live-current source studies, Phase 07 replay,
and adversarial authority/privacy tests are reported separately. AI-authored labels are explicitly
`expert_draft`, never called human gold. Unjudged documents are reported as unjudged instead of
silently treated as irrelevant when pools are incomplete.

The Phase 07 baseline remains: 0.9141 judged top-five recall across the frozen set, with only two of
five expected results for the context-reduction mechanism query and substantial unjudged live leads.

## Deliberate non-goals

- software or model installation, invocation, deployment, or permission granting;
- agent orchestration, project-management workflow, sandboxing, or CI/CD control;
- hosted authentication, cloud/model fallback, or mandatory external credentials;
- a whole-web crawler, generic social scraper, marketplace, or general-purpose graph platform;
- claims of corpus completeness or legal clearance from a naming screen.

## Deeper records

- [ADR-001](docs/architecture/ADR-001-v0-foundation.md)
- [ADR-002](docs/architecture/ADR-002-phase-06-intelligence-explorer.md)
- [ADR-003](docs/architecture/ADR-003-discovery-intelligence.md)
- [ADR-004](docs/architecture/ADR-004-intelligence-product-refoundation.md)
- [Schema contract](docs/architecture/schema.md)
- [VCS policy](docs/VCS-POLICY.md)
- [Security review](docs/security-review-v0.md)
