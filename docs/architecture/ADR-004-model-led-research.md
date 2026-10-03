# ADR-004: Model-led, evidence-bound research

- Status: accepted for Phase 08 implementation
- Date: 2026-09-30
- Supersedes: ADR-003 decisions 1, 2, and 5 as the active semantic center; preserves all historical
  records and replay

## Context

Phase 07 proved bounded source adapters, immutable candidates, optional structured model output,
Search/Corpus identity, and durable replay. Phase 08's first implementation attempt then expanded
handwritten query grammar, seeded concepts, retrieval fusion, reranking heuristics, and learned
title vocabulary. That work improved some known cases but required increasing semantic policy for a
domain that is open-ended. It optimized the deterministic approximation before proving the user
value of the research method.

The product must answer needs from unseen domains and materially outperform an ungrounded direct
LLM answer. The model is well suited to open-world interpretation and adaptive research, while code
is better suited to exact authority, privacy, provenance, validation, and replay.

## Decision

1. Adopt one bounded `research-skill-v1` state machine for both live Search and admitted Corpus.
2. Use a provider-neutral model interface for planning, one evidence-bound refinement, and
   synthesis. Begin with a single explicitly configured loopback structured-output model. Add
   routing or multiple models only when evaluation shows a material gain.
3. Let the model propose only searches through source keys supplied by the host. The host validates
   every action, clamps budgets, performs calls, and passes back compact attributed candidates.
4. Require refinement and synthesis to cite exact stored candidate IDs. Synthesis must state
   whether context is sufficient: sufficient output requires self-cited findings, organized groups,
   and summary citations; insufficient output must abstain without findings and explain the gap.
   Unknown IDs, unsupported
   sources, arbitrary action fields, duplicate references, and over-budget actions fail closed and
   receive durable rejection evidence.
5. Keep Search and Corpus acquisition distinct. Search uses enabled current sources; Corpus uses
   admitted local records and cannot call the network. Both share the proposal and synthesis
   contract.
6. Keep Phase 06/07 deterministic semantics unchanged for replay. Use them as an explicit fallback,
   candidate generator, exact checker, and evaluation comparator—not as the primary open-world
   intelligence.
7. Preserve `catalog`/`workspace`/`ops` separation. Project context is not sent to the model or
   public sources in this phase. Live leads require explicit admission before becoming Corpus.
8. Store model/config/input/output hashes, exact structured output, source outcomes, usage, safety checks, validator
   receipts, source operations, acquisition-time candidate snapshots and links, stop reason, and
   terminal run receipt. Re-rendered replay is deterministic; new model generation is not.
9. Package the method as a repository skill so a user's own agent can apply the same research
   practice. The skill grants no additional execution authority.

## Consequences

The central semantic implementation is smaller in concept but model-dependent for its strongest
behavior. A no-model installation remains useful through deterministic Search and Corpus, with an
explicit quality distinction. Model cost, latency, and provider quality must be measured, but they
do not justify a router before research usefulness is demonstrated.

Model output can be coherent and still wrong. Exact citation validation proves only that cited
records exist; human or independent evaluation must still assess whether claims are supported,
coverage is sufficient, and organization is useful.

Candidate-level citations plus summary citations and an explicit context-sufficiency/abstention
judgment are the Phase 08 floor, not the final evidence model. Usefulness testing must determine
whether finer claim-level support is necessary before Corpus admission or hosted operation.

The discarded Phase 08 spike remains on its pushed branch and PR as an auditable experiment. It is
not rewritten into migration history or force-pushed away.
