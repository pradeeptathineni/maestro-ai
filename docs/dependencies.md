# Dependency baseline

The runtime and verification packages are exact-pinned in `package.json` and `package-lock.json`.
Core versions were checked on 2026-09-25. Phase 06 additions were checked against current npm
metadata and upstream version-matched documentation on 2026-09-29:

| Package                  | Version | License    | Relevant Node declaration                           |
| ------------------------ | ------: | ---------- | --------------------------------------------------- |
| Fastify                  |  5.12.5 | MIT        | supported by the verified Node 24 build             |
| React / React DOM        |  19.3.0 | MIT        | compatible                                          |
| Vite                     |   8.3.1 | MIT        | `^20.19.0` or `>=22.12.0`                           |
| TypeScript               |   6.0.3 | Apache-2.0 | `>=14.17`                                           |
| PostgreSQL driver (`pg`) |  8.23.0 | MIT        | `>=16`                                              |
| Drizzle ORM              |  0.45.3 | Apache-2.0 | compatible                                          |
| Graphile Worker          |  0.18.0 | MIT        | `>=22.18`                                           |
| TypeBox                  |  1.3.34 | MIT        | compatible                                          |
| OpenTelemetry API        |   1.9.1 | Apache-2.0 | compatible                                          |
| TanStack Query           | 5.103.2 | MIT        | compatible                                          |
| Playwright Test          |  1.63.0 | Apache-2.0 | `>=20`                                              |
| Vitest                   |   5.0.2 | MIT        | `^22.12`, `^24`, or `>=26`                          |
| AntV G6                  |   5.1.1 | MIT        | browser renderer; verified Node 24 build            |
| Mozilla Readability      |   0.6.0 | Apache-2.0 | worker-side extraction with jsdom                   |
| AI SDK                   | 7.0.122 | Apache-2.0 | Node 22+; compatible with Node 24                   |
| AI SDK OpenAI-compatible |  3.0.59 | Apache-2.0 | provider interface v4 used by AI SDK 7              |
| jsdom                    |  30.1.1 | MIT        | Node >=20; runtime DOM for extraction               |
| undici                   |  7.30.0 | MIT        | connection-time DNS policy for fixed public fetches |

Development-only Phase 06 tools are exact-pinned: `repomix@1.18.1` (MIT) for bounded repository
maps, `@linger-alpha/cca@0.2.0` (MIT) for a reversible project hook, `knip@6.38.0` (ISC) for unused
code/dependencies, and `jscpd@5.3.3` (MIT) for clone detection. None grants runtime execution
authority or makes a catalog candidate trusted.

The verification gate checks that all direct packages remain at their exact reviewed versions and
use the reviewed MIT, Apache-2.0, ISC, or MPL-2.0 licenses. The 2026-09-30 installed-tree audit reported
zero known vulnerabilities. These are time-scoped dependency checks, not a claim that the
application or dependencies are universally safe. CI and the local verification gate repeat them.

Npm's local build-script policy may block optional `esbuild`/`fsevents` lifecycle scripts. Maestro
does not require a global policy change: the pinned Vite build and browser gate are used to verify
the effective installation.

G6 is lazy-loaded and owns drawing/layout only. Readability runs only on already bounded,
allowlisted HTML; jsdom scripts and resource loading remain disabled and only plain extracted text
is persisted. AI SDK has no default model route in Maestro: only an explicit loopback-compatible
endpoint can enable the optional adapter, SDK retries are disabled/accounted by the application,
and no model or embedding artifact is downloaded automatically. The declared input-token limit is
checked against endpoint-reported usage when present; absent usage is recorded as unmeasured. See the
[Phase 06 reference](architecture/phase-06-reference.md) for local integration contracts.
