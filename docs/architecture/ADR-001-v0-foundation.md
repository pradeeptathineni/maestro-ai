# ADR-001: v0 modular-monolith foundation

Status: accepted, implementing discovery decisions D-003 through D-009 and D-026.

Maestro v0 is a strict-TypeScript modular monolith with a React/Vite client, Fastify API,
PostgreSQL 18, checked SQL migrations with Drizzle definitions, and Graphile Worker behind an
operational job boundary. Node 24 was still Active LTS when dependencies were pinned on
2026-09-25.

The database uses separate `catalog`, `workspace`, and `ops` schemas. Catalog records cannot
reference private workspace rows. Stable projects own immutable context snapshots; decisions bind
to those snapshots. Queue jobs are intake mechanics and are not Maestro product runs.

The future adapter plan and receipt vocabulary is retained as compile-time contracts only. There is
no installation, permission, invocation, model-routing, orchestration, sandbox, CI/CD, or deployment
surface in v0.
