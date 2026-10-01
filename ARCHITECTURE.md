# Architecture

Maestro is currently a local-first research system for finding high-signal existing knowledge that
can help a project. **Search** investigates current public sources for a user's live need.
**Corpus** searches admitted, refreshable knowledge. They use one research judgment protocol but
remain different evidence universes and user experiences.

`Signals AI` is a working product name only. The repository and package remain `maestro-ai` because
the [naming gate](docs/product-split-and-naming.md) found material active-market collisions.

## Value loop

```text
public need
  -> model proposes questions + allowed-source searches
  -> deterministic host validates privacy, tools, and budgets
  -> live adapters OR admitted Corpus return attributed evidence
  -> model assesses coverage and proposes one bounded refinement or stop
  -> deterministic host validates every referenced evidence ID
  -> model selects, groups, explains, and cites the useful landscape
  -> Search result
       -> explicit reviewed admission -> Corpus
       -> watches + new observations -> append-only revisions
       -> future Search candidate generation and comparison
```

The model owns open-world interpretation, terminology, search refinement, relevance judgment,
organization, and explanation. It does not receive shell access, general tool authority, private
project context, or permission to install or execute candidates.

Deterministic code owns the parts where exactness is both achievable and valuable: schemas,
enabled-source allowlists, network policy, disclosure, budgets, deadlines, identifiers,
deduplication, citation existence, provenance, persistence, explicit admission, privacy, and replay.
It also provides a transparent fallback and evaluation comparator. It must not grow a query-word
rulebook that impersonates open-world understanding.

## One protocol, two modes

`research-skill-v1` has three untrusted structured model outputs:

1. **Plan** — interpretation, research questions, allowed-source queries, and stop tests.
2. **Refinement** — evidence-bound gap assessment and either another bounded action or a stop.
3. **Synthesis** — ordered/grouped candidate IDs, reasons, uncertainty, and exact citations.

In `search` mode, allowed actions address only explicitly enabled public adapters. In `corpus` mode,
the only source is admitted indexed knowledge and no network call is possible. A provider-neutral
model interface currently has one explicit loopback OpenAI-compatible implementation. There is no
cloud fallback, automatic model download, or model router. The model choice and token economics are
evaluation variables, not product ontology.

The existing deterministic query and retrieval policies remain versioned for Phase 06/07 replay.
When no model is configured, they remain the declared fallback. They also support exact identity,
literal constraints, candidate generation, must-find checks, and model-output auditing. New
semantic quality should be attributed to the model protocol rather than silently credited to the
fallback.

## Signal is not one opaque score

The product must keep these questions separate:

- **query relevance:** why this item addresses the current need;
- **evidence confidence:** what sources support each material claim and how independent/current
  they are;
- **intrinsic Signal:** evidence-backed indicators of reuse leverage, adoption burden, maturity,
  maintenance, safety, and similar value dimensions independent of this query;
- **project fit:** private constraints and preferences, assessed only inside the workspace.

Model judgment may propose labels and explanations. Numeric or categorical measures require a
versioned policy, observable inputs, missing-data semantics, evidence bindings, and replay. Old
`query-signal-v1` and `query-signal-v2` receipts retain their historical meaning. The system will not
invent a stronger intrinsic Signal from stars, mentions, model confidence, or absent evidence.

## Trust and data boundaries

- `catalog`: public/shareable admitted entities, documents, sources, observations, evidence, and
  append-only revisions;
- `workspace`: private queries, project context, shortlists, decisions, and user lifecycle state;
- `ops`: adapter configuration, research runs, attempts, raw leads, model proposals, validation
  receipts, leases, health, and audit records.

Live leads stay in `ops`. Collection does not make them Corpus knowledge. Admission is an explicit,
typed, evidence-bound action. Public records may not depend on private workspace content. Fetched
content is untrusted data.

Historical migrations are never rewritten. Stored model output can be hash-verified and rendered
again; a fresh model invocation is not claimed to reproduce it. Corrections append a successor or
revision rather than mutating an immutable receipt.

## Product surfaces

- **Local/agent use:** the repository API and `.agents/skills/maestro-research` let a user's own
  model-enabled agent apply the method while Maestro supplies evidence and guardrails.
- **Search UI:** live research progress, source coverage, organized findings, citations,
  uncertainty, and admission actions are primary. Cached Corpus matches are a visible cross-check.
- **Corpus UI:** browse and query durable admitted knowledge, evidence state, revisions, and refresh
  status. Raw Search leads are not a Corpus layer.
- **Hosted direction:** an operator can continuously curate and refresh a larger public Corpus so
  users receive value without maintaining it themselves. Hosted auth, billing, and deployment are
  not implemented in this phase.

## Evaluation before optimization

Freeze prompts and semantics, then compare model-led research, the deterministic fallback, and a
strong direct-model answer under declared evidence/tool budgets. Evaluate unseen domains for human
relevance, coverage, useful organization, citation support, false inclusion, important omission,
stability, calls/tokens, elapsed time, and cost. Must-find lists must be independently created and
kept out of production code and prompts.

Latency and scale work are warranted only after usefulness is credible, except where a bounded
operational mechanism is necessary to make the evidence trustworthy.

## Reused prior art and current decisions

The detailed evidence and adoption status live in the
[architecture reuse register](docs/architecture/reuse-register.md). The governing decision is
[ADR-004](docs/architecture/ADR-004-model-led-research.md). Earlier ADRs and
[the schema map](docs/architecture/schema.md) remain historical authority for preserved records.

## Explicit non-goals

No candidate installation or execution, arbitrary crawling, general browser automation, hosted
identity, payment, deployment control, model gateway, multi-agent runtime, or old Maestro
orchestration end-state is authorized here. Cataloged systems remain evidence-bearing data until a
separate approved phase grants typed authority.
