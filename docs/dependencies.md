# Dependency baseline

The runtime and verification packages are exact-pinned in `package.json` and `package-lock.json`.
On 2026-09-25, npm registry metadata confirmed the selected core versions and Node 24 compatibility:

| Package                  | Version | License    | Relevant Node declaration               |
| ------------------------ | ------: | ---------- | --------------------------------------- |
| Fastify                  |  5.12.5 | MIT        | supported by the verified Node 24 build |
| React / React DOM        |  19.3.0 | MIT        | compatible                              |
| Vite                     |   8.3.1 | MIT        | `^20.19.0` or `>=22.12.0`               |
| TypeScript               |   6.0.3 | Apache-2.0 | `>=14.17`                               |
| PostgreSQL driver (`pg`) |  8.23.0 | MIT        | `>=16`                                  |
| Drizzle ORM              |  0.45.3 | Apache-2.0 | compatible                              |
| Graphile Worker          |  0.18.0 | MIT        | `>=22.18`                               |
| TypeBox                  |  1.3.34 | MIT        | compatible                              |
| OpenTelemetry API        |   1.9.1 | Apache-2.0 | compatible                              |
| TanStack Query           | 5.103.2 | MIT        | compatible                              |
| Playwright Test          |  1.63.0 | Apache-2.0 | `>=20`                                  |
| Vitest                   |   5.0.2 | MIT        | `^22.12`, `^24`, or `>=26`              |

The verification gate checks that all direct packages remain at their exact reviewed versions and
use the reviewed MIT, Apache-2.0, or MPL-2.0 licenses. The 2026-09-25 installed-tree audit reported
zero known vulnerabilities. These are time-scoped dependency checks, not a claim that the
application or dependencies are universally safe. CI and the local verification gate repeat them.

Npm's local build-script policy may block optional `esbuild`/`fsevents` lifecycle scripts. Maestro
does not require a global policy change: the pinned Vite build and browser gate are used to verify
the effective installation.
