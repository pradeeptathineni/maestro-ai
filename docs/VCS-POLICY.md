# Version-control and release policy

## Pre-1.0 operating mode

- Use short-lived `codex/*` branches and small, coherent Conventional Commits.
- Push each meaningful green checkpoint so remote state is recoverable and CI evidence is attached
  to the exact commit.
- Use pull requests for all phase integration, inspect the full diff, and record an independent AI
  review before merge.
- Treat GitHub checks as evidence, not as a substitute for local migration, replay, security, and
  evaluation review.
- Reserve human approval for explicit naming, authority, publication, release, and other policy
  decisions. An internal working name is not a release decision.

The repository had no branch protection or ruleset at the Phase 08 baseline. Until a repository
ruleset is deliberately enabled, this document and the Phase 08 gate are self-imposed mandatory
policy: absence of a server-side block is not permission to bypass a failed check.

## Commit form

Use Conventional Commit messages with a product-area scope when useful:

```text
docs(architecture): record intelligence product split
feat(taxonomy): add versioned concept relationships
feat(search): add budgeted two-pass research plans
refactor(signal): decouple match from intrinsic signal
test(retrieval): add unseen-domain challenge set
fix(db): preserve relationship revision ownership
```

Breaking compatibility requires a `!` or `BREAKING CHANGE:` footer and an explicit pre-1.0 release
decision. Phase 08 is designed to be additive and must retain historical replay.

## Prohibited

- force-pushing shared `main` or rewriting accepted/released history;
- bypassing failed mandatory CI, migration, replay, privacy, authority, or security gates;
- committing secrets, private planning text, raw credential-bearing payloads, or retained local data;
- editing an old migration, score policy, immutable receipt, or accepted observation in place;
- merging knowingly broken migrations or query-specific benchmark behavior;
- publishing a package, release, or public rename without the corresponding explicit decision.

## Phase 08 merge rule

The Phase 08 pull request may merge only when all of the following are true:

1. the branch is based on the pushed Phase 07 baseline and is up to date with `main`;
2. the full clean verification gate and remote CI pass at the reviewed head SHA;
3. migration from the Phase 07 baseline, backup/restore, and historical policy replay pass;
4. frozen development, gold-candidate, unseen challenge, and live-current reports identify their
   label provenance and satisfy the declared mandatory thresholds;
5. database, security, dependency, performance, UI, and code reviews have no open critical finding;
6. an independent AI reviewer has inspected the diff and its findings are resolved or explicitly
   accepted by policy;
7. anti-overfitting checks find no evaluation-query coupling and scope review finds no accidental
   orchestration or execution authority;
8. the working-name collision is not disguised as a public rename.

After merge, verify `main` CI and record the exact merge and successful-run SHAs in the Phase 08
handoff. A release or repository rename remains a separate action.
