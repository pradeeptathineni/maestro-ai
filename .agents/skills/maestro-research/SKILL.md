---
name: maestro-research
description: Research an open-ended project need against live public sources or a local Maestro Corpus and return organized, evidence-bound options. Use when the user asks to discover, survey, compare, or find high-signal existing tools, services, practices, standards, models, articles, or other reusable knowledge. Do not use it to install or execute candidates.
---

# Maestro Research

Produce a better result than an ungrounded model answer by coupling model judgment to acquired evidence.

## Choose the evidence universe

- Use **Search** for current external discovery. Treat every result as a lead until its claims are supported.
- Use **Corpus** for admitted indexed knowledge. Do not silently substitute live leads for Corpus records.
- Use both when the user wants current coverage plus a check against durable knowledge. Report which universe produced each item.

If a local Maestro API or repository is in scope, read [references/research-protocol.md](references/research-protocol.md) before driving it. Otherwise apply the method with the agent's available public research tools and return the same evidence-bound result shape.

## Research method

1. Preserve the user's actual need, constraints, and requested breadth. Surface consequential ambiguity; do not replace the query with a memorized landscape label.
2. Form a small research plan: the questions whose answers would make the landscape useful, the source types likely to answer them, and what would count as enough coverage.
3. Derive searches from the need and from evidence encountered during the run. Do not use query-specific production dictionaries or expected-answer lists.
4. Prefer primary sources for capabilities and current facts. Community and aggregator results may reveal candidates, but corroborate material claims before presenting them as established.
5. Keep an evidence ledger with a stable candidate ID, canonical URL, title, source type, observed date when available, and the exact claims the source supports.
6. Check gaps after the first pass. Run a bounded follow-up only when it can resolve a material category, terminology, recency, or corroboration gap.
7. Resolve exact duplicate identities mechanically. Keep distinct alternatives distinct; never merge merely because descriptions sound similar.
8. Organize the result around the user's decision or exploration need. Explain why each selected item matters, cite its stored evidence, expose uncertainty, and name important omissions.

## Deterministic checks

Use deterministic mechanisms as safeguards and supplements:

- enforce source, privacy, call, time, and result limits;
- verify every cited ID or URL exists in the acquired evidence;
- check literal user constraints and any user-supplied must-find items;
- deduplicate exact identities and preserve provenance;
- compare coverage across planned questions and source classes;
- flag instability or disagreement across repeated runs.

Do not turn missed examples into a growing semantic word list. Popularity, stars, or mention counts are clues, not intrinsic proof of quality or project fit.

## Finish

Return a concise landscape summary, useful groups, ordered evidence-backed items, why each fits, citations, uncertainties, and coverage gaps. Distinguish observed facts, model judgments, and deterministic checks. Stop when the remaining gap is unlikely to change the useful answer within the declared budget, or when permitted sources cannot close it.

Never install, execute, deploy, authenticate to, or grant authority to a candidate unless the user separately requests and authorizes that work.
