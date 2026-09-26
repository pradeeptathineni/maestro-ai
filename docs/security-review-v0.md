# Focused v0 security review

Review date: 2026-09-25

Scope: the local single-operator Prompt 02 slice, including the browser/API boundary, PostgreSQL
ownership constraints, curated seed, URL intake, Graphile Worker adapter, logs/traces, dependencies,
and the absence of authority-bearing execution features.

## Outcome

No unresolved critical or high-severity issue was found for the documented local v0 boundary. The
Prompt 02 recovery found and corrected reserved-address coverage and worker-finalization gaps. The
subsequent independent review found and corrected historical choice/policy mutability, provider
version ownership, unsupported hard-gate assumptions, concurrent intake processing, and several
input-boundary weaknesses. None added an arbitrary network or execution path; the hardened controls
now match the documented local contract.

## Threat/control map

| Threat or property                     | Implemented control                                                                                                                                                                                                                                                                                                                                               | Verification evidence                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted content causes execution     | Remote notes and metadata remain strings/JSON; React escapes them; there is no HTML renderer, shell/process adapter, installation path, or capability invocation route                                                                                                                                                                                            | `api.integration.test.ts` inert-note curation case; OpenAPI route allowlist; source scan for process/HTML execution sinks        |
| SSRF, rebinding, or credential leakage | Absolute HTTPS only; credentials, nonstandard ports, loopback, private, link-local, mapped IPv6, multicast, and documented/reserved networks rejected; unknown hosts are manual-only; the optional GitHub adapter fixes `api.github.com`, encodes path segments, omits credentials, rejects redirects, bounds time/type/bytes, and is network-disabled by default | `domain.test.ts`; `github-metadata.test.ts`; `api.integration.test.ts` rejected-host path                                        |
| Discovery becomes authority            | Catalog effects are descriptive data. No install, configure, grant, approval, invocation, execution, sandbox, CI/CD, deployment, model-routing, or orchestration API/job/table/UI exists                                                                                                                                                                          | Exact OpenAPI path assertion and repository scope scan; `ExecutorPort` remains a compile-time future seam with no implementation |
| Public/private data leak               | Separate `catalog`, `workspace`, and `ops` schemas; workspace IDs and composite ownership foreign keys; no catalog-to-workspace foreign key; public repository queries only catalog; private evidence may be referenced only from private fit                                                                                                                     | Schema-direction, ownership, private-fit canary, and public-search integration tests                                             |
| Identity confusion and duplicate races | Typed identity schemes, active-identity uniqueness, deterministic URL normalization, exact/idempotency/strong-identity matches, database uniqueness, reversible identity-event shape, and human curation                                                                                                                                                          | URL property/unit cases and concurrent duplicate integration test                                                                |
| Evidence or decision history rewrite   | Source observations, claims, evidence, score policies/runs, constraints, candidate semantics, need revisions, fit, recommendations, private evidence, decisions, and events are append-only. Receipts are checked before being presented as verified. Worker attempts allow one coherent finalization transition and then become immutable/non-deletable          | Migration tests, immutable semantic-input tests, worker finalization/recovery tests, receipt and score replay                    |
| Publisher or score laundering          | Claims and evidence are separate; publisher independence is enforced by the seed audit; missing values stay typed; scores shrink for confidence and expose policy, components, evidence IDs, gaps, and input hashes                                                                                                                                               | Seed audit, scoring properties/golden tests, stored-score replay, UI evidence path                                               |
| Browser/API request abuse              | Loopback-only bind and web-origin validation, explicit Host/Origin allowlists, no wildcard credentials, required JSON and `x-maestro-request` on mutations, 64 KiB body limit, rate limit, CSP/frame denial/nosniff/referrer policy, schema validation, and generic correlation-ID errors                                                                         | Configuration/unit tests, API boundary integration tests, and production browser gate                                            |
| Secret/private log leakage             | No third-party secret is needed; request logging does not include bodies; structured redaction covers authorization, cookies, notes, prompts, raw content, credentials, tokens, and private paths; spans contain method/route/status only                                                                                                                         | Logging unit test and high-confidence repository secret scan                                                                     |
| Supply-chain substitution              | Exact package versions and lockfile, direct-license allowlist, advisory audit, pinned CI action commits, offline deterministic seed import, and no live fetch in migrations/build                                                                                                                                                                                 | `security:dependencies`, `npm audit`, `security:secrets`, CI file inspection, idempotent seed tests                              |
| Queue/resource abuse                   | Transactional outbox, unique operation keys, deliberate bounded retries, per-intake advisory locks, coherent terminal attempt receipts, small worker concurrency, request/body limits, streaming metadata byte cap, and minimal metadata persistence                                                                                                              | Worker/API/adapter integration tests and attempt-transition migration                                                            |
| External mutation                      | V0 performs no external writes. Optional network behavior is a bounded unauthenticated GitHub metadata read only when the operator explicitly changes the default environment setting                                                                                                                                                                             | Adapter tests and default configuration review                                                                                   |

## Corrections made during recovery

1. Moved the Fastify error handler before route registration so validation failures consistently use
   the stable problem-details boundary.
2. Added PostgreSQL migration `0005` to repair the prior trigger that prevented every job attempt
   from recording an outcome.
3. Added migration `0006` to permit only one valid attempt-finalization transition and reject later
   mutation; a replacement attempt first marks a stranded predecessor as interrupted.
4. Expanded URL denial tests and policy to cover carrier-grade NAT, documentation/benchmark ranges,
   encoded loopback, IPv4-mapped IPv6, site-local/multicast IPv6, and IPv6 documentation space.
5. Added deterministic direct-version/license and secret checks to the verification gate.

## Corrections made during independent review

1. Added migration `0007` to enforce provider/version ownership, exact need/context ownership,
   candidate snapshot binding, and append-only decision-relevant semantics.
2. Changed newly entered status-quo/build/defer options from unevidenced hard-gate `pass` values to
   explicit `unknown` values governed by each constraint's unknown policy.
3. Expanded stored-score replay to verify the policy document, input hash, dimension outputs, and
   aggregate output; future seed hashes normalize set-valued evidence identifiers.
4. Serialized intake processing with a database advisory lock, converted adapter throws into
   finalized transient receipts, and left expected retries under the explicit intake retry path.
5. Made rejected URLs deduplicate deterministically, restricted curation to reviewable states, and
   stopped oversized GitHub responses while streaming rather than after buffering the body.
   A follow-up uniqueness migration also collapses concurrent URL variants with the same strong
   GitHub repository identity.
6. Validated the configured browser origin as loopback-only and made receipt-hash failure visible
   instead of displaying an unconditional success badge.

## Accepted v0 limitations

- The single trusted local operator has no authentication or row-level security; hosted/multi-user
  exposure is out of scope and would require both.
- The compose password is a documented local development credential, not a production secret.
- The fixed-host GitHub reader does not implement a general DNS-pinning fetcher because arbitrary
  remote retrieval is intentionally absent. Redirects are rejected and live retrieval is off by
  default.
- The secret scan uses high-confidence signatures and complements review; it is not a universal
  secret detector.
- Source display metadata is curated and has no public mutation API, but the v0 database does not
  yet revision every edit to `catalog.sources`; immutable observations retain the retrieved URI and
  digest.
- HOL Guard/runtime sandboxing is absent and not claimed. No discovered code is executed, so those
  controls remain deferred with the execution plane.
- Backup encryption, hosted retention, authenticated export/promotion, and per-tenant controls are
  deferred because v0 has no hosted boundary or export surface.

These limitations do not weaken the accepted Prompt 02 boundary. Any network exposure,
multi-user mode, arbitrary retrieval, model processing, installation, permission, or execution
feature requires a new authority/threat review before implementation.
