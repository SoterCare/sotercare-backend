# Backend task breakdown: design

Date: 2026-11-19. Project: `sotercare-backend` (SerenEdge key `SOTERCAR`, deadline 15 Dec 2026).

## Intent and why

The backend is fully specified in three spec files and one plan (Tasks 0–41). The work now flows through SerenEdge, so developers' agents need that plan as SerenEdge tasks they can claim one at a time. This design says how the existing plan becomes those tasks. It adds no new product behaviour.

Sources of truth (not rewritten here):
- `docs/spec.md` (§1–§15, core and safety)
- `docs/spec-part2-people-and-care.md` (§16–§25)
- `docs/spec-part3-family-ai-money-ops.md` (§26–§35)
- `docs/plan.md` (Tasks 0–41, with files, steps, lanes and dates)

## Goals

- Every plan task from 1 to 41 becomes one SerenEdge task with acceptance criteria, definition of done, an agent prompt that names files and the first failing test, security notes and an hours estimate.
- Dependencies match the plan's real order, so independent slices can run in parallel.
- Tier 2 (backend core, Tasks 1–16) is dated and ordered first. The safety core (Tasks 10, 11, 12, 36) is never cut.
- Milestones: T2-1 (24 Nov), T2-2 (27 Nov), CP9 / development complete (28 Nov), INT (30 Nov – 4 Dec).

## Non-goals

- No rewrite of the three spec files or `docs/plan.md`.
- No change to any product rule in `CLAUDE.md` (tenant isolation, no alerts from telemetry, no band-assignment writes, medication boundary).
- Task 0 (import with history) is treated as done: the import and cleanup commits are in `main`.

## Anti-goals

- A task that breaks the build, or that cannot be tested alone.
- Manual work (accounts, keys, DNS) hidden inside code tasks without an owner.
- Splitting a task in a way that leaves half of it unusable.

## Constraints

- One task is one reviewable pull request. The Head chose **not to split large tasks**: tasks the plan sizes above 800 changed lines (for example Tasks 5, 26, 34 and 37) are kept whole and set `allowLarge: true`.
- Branches `task/SOTERCAR-<n>-<slug>` or `issue/...` off `dev`; commits `SOTERCAR-<n>: summary`; no AI attribution (see `CLAUDE.md`).
- The project has no CI yet (no `.github/`, no `.serenedge/ci.json`), so the first task is the CI foundation task and every other task depends on it.
- Points pricing is off. Tasks carry `estimateHours` only.

## Approaches considered

1. **One SerenEdge task per plan task, large ones kept whole with `allowLarge`** (chosen by the Head). Matches the plan's own sizing and lanes, and keeps traceability from task to plan section. Cost: a few big reviews.
2. Split every task above 800 lines into slices. Smaller reviews, but more tasks, more dependencies and partial slices that are hard to test alone. Rejected by the Head.
3. Group by milestone (about ten big tasks). Too coarse for one agent session. Rejected.

## Decisions

- **Mapping:** plan Task N → SerenEdge task `tN`. A CI foundation task `t0` (`ciFoundation: true`, type `deploy`) comes first and replaces Task 0's CI part. Each Part gets a `test` task for its acceptance (Task 16 for Part 1, Task 41 for Parts 2 and 3). Tasks of type `dev` list the relevant acceptance task in `testedBy`.
- **Types:** `dev` for backend features, `test` for Tasks 16 and 41, `deploy` for the CI foundation, `manual` only where nothing in code depends on the step.
- **Milestones:** `T2-1` (24 Nov), `T2-2` (27 Nov), `CP9` (28 Nov), `INT` (30 Nov – 4 Dec).
- **Lanes (B1/B2/B3):** recorded in each task's `skillTags` and description; they do not change dependencies.
- **Agent prompt rule:** each prompt ends with `Plan: docs/superpowers/plans/<file>.md#<anchor>`. The superpowers plan will summarise each task and point to the full steps in `docs/plan.md`.

## Security and manual work

Touches, by flag:
- **auth:** Tasks 3, 6, 17, 18, 19 (Cognito guard, service token, MFA gate, station PIN, ops pool).
- **permissions:** Tasks 7, 8, 21, 25, 37, 39 (allow-lists, role checks, support access, two-person rule).
- **payments:** Tasks 34, 35, 36 (PayHere webhooks, invoices, suspension).
- **secrets:** Tasks 6, 10, 12, 35 (Ed25519 keys, local credential, band keys and provisioning bundles, PayHere merchant secret).
- **migrations:** Tasks 2, 4 and any task adding tenant or control migrations.
- **dependencies:** Tasks 1, 14, 34 (`jose`, Parquet writer, `pdfmake`, `sharp`). New packages need approval.
- **personal_data:** Tasks 18, 21, 25, 26, 29, 30, 31, 40 (residents, family, medication, medical records, voice notes, exports, ARIA).
- **infra:** Tasks 2, 5, 9, 11, 25, 37, 38 (SQS, SNS, S3, KMS, IoT, Cognito, Step Functions).

Manual setup that a person must do (owner in brackets). Exact values go into the task analysis; the owner list is:
- Cognito: ops pool and per-tenant pools (`devops`, via `sotercare-infra`).
- AWS: SQS queues and DLQs, SNS platform apps for APNs / FCM, SES sender domain, S3 buckets with KMS keys, IoT Core rules and policies (`devops`).
- PayHere merchant account, merchant ID and secret, webhook URL per environment (`head` for the account, `devops` for the secret in AWS Secrets Manager).
- Ed25519 service-token signing key and local-credential key (`devops`; secrets, never in git).
- Apple and Google push credentials (`head` / `client`).
- `@sotercare/contracts` access through GitHub Packages (`devops`: a token with `read:packages`).
- GitHub branch protection for `main` and `dev`, and the CI workflow trigger (`head`).

## What is left to the builder

Each task's detailed steps stay in `docs/plan.md`. The builder follows the spec sections that the plan task names, and keeps the Global Constraints and the Review Focus tests from `docs/plan.md`.

## Open calls I made (check these)

1. Task 0 is done; no SerenEdge task for it, except the CI foundation task.
2. `allowLarge: true` is set on every task I estimate above 800 changed lines, not on all tasks.
3. Where the plan gives two lane owners (Tasks 13, 38, 16, 41), the task stays whole and names both lanes.
