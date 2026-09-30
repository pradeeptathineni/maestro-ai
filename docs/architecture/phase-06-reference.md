# Phase 06 implementation reference

## User path

`query -> local indexed results + configured source searches -> signal/confidence/evidence -> list/map/detail/compare -> optional project shortlist -> existing gate-first decision`

The list, map, detail, comparison and export must use the same result-set ID and revision. A refresh creates a successor revision. Cursor pagination is bound to that revision and a deterministic position; new catalog rows cannot move an existing cursor.

Every completed source operation stores attributed candidates as immutable preliminary leads. The
Corpus surface reads those durable leads alongside indexed knowledge, deduplicates its current view
by canonical URI and reuses the same query policy when the operator supplies a need. Browse-only
mode does not invent a universal score. Admission creates a proposed or reviewed projection with
bound evidence; it is not required for a source lead to receive a preliminary query estimate.

## Policy ownership

- PostgreSQL FTS/trigram and the versioned vocabulary generate candidates. Retrieval is not recommendation.
- `query-signal-v1` owns query relevance plus supported reuse value. `consideration-v1` remains the public general score. `project-fit-v1` remains gate-first private fit.
- Every returned result has a numeric query-signal estimate. Coverage and source-review state qualify confidence; they never stand in for, or suppress, calculation.
- A model may propose bounded intent/mappings with source anchors. TypeBox/AI SDK shape validation is necessary but does not verify truth; review state and attribution stay visible.
- Provider display, assessment inputs and policies used by history are revision-bound or snapshotted. Old records never borrow current labels silently.

## Selected mechanisms

- `@antv/g6@5.1.1`: render/layout/viewport only; destroy the graph on React cleanup.
- `@mozilla/readability@0.6.0` plus `jsdom@30.1.1`: approved HTML to plain normalized text only after fetch bounds; scripts/resources disabled; never render returned HTML as trusted content.
- `ai@7.0.122` plus `@ai-sdk/openai-compatible@3.0.59`: optional loopback-only structured proposals. Use the installed docs and `jsonSchema()`/`Output.object()`; disable SDK retries and validate anchors/IDs after generation.
- `undici@7.30.0`: fixed public hosts use a connection-time DNS lookup that rejects any reserved address, including a changed DNS answer. Local configured endpoints use a separate loopback-only path.
- Native fetch: GitHub, official MCP Registry and configured SearXNG contracts. One application layer owns retry/accounting.

## Security invariants

- Network is off by default. A public source query can contain only the disclosed public query, never project context or notes.
- Public adapters use exact configured HTTPS hosts; privileged local endpoints use explicit loopback configuration and cannot be selected by source/model content.
- Validate schemes, host/port, DNS/IP, redirects, content type, compressed/decompressed size and deadlines. Strip credentials on redirects. No ambient cookies or filesystem/browser authority.
- Source and model text is inert data. It cannot mutate policy, permissions, budgets, configuration, identities, scores or publication state.
- Logs redact raw query/prompt/content/path/token/credential values; operational records use hashes, lengths and safe classifications.

## Verification routing

Database/integration/E2E scripts are destructive to their target schemas. Follow root `AGENTS.md` and use explicit disposable URLs. Deterministic CI uses frozen fixtures and no live network/model. Live adapter/model lanes have separate status and never inherit a pass from fixtures.

## Optional semantic operation

Enabling `local_semantic` stores a loopback endpoint, exact model identifier, output ceiling and a
declared input-token limit. Each explicit semantic-proposal API request reserves one call and queues
`phase06_semantic_v1`; the worker disables SDK retries, validates the bounded schema, capability
group allowlist and exact query anchors, and stores an immutable attributed proposal. Endpoint
reported input usage is checked against the declared limit when available; absent usage remains
unmeasured. The proposal is never applied to ranking or result data automatically.

## Repository context engineering

Root `AGENTS.md` is a short safety/router document. The repo-scoped
`maestro-context-engineering` skill progressively discloses the tool-selection matrix. Repomix
produces a disposable, secret-scanned pack under `.codex/context-cache`; CCA is pinned as a local
development dependency for the project hook, which remains inactive until the operator reviews and
trusts the project configuration. Knip and jscpd are structural verification gates. Generated packs
and compressed previews never replace source as authority.
