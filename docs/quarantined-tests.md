# Quarantined legacy test suites

These suites are excluded in `package.json` (`jest.testPathIgnorePatterns`). They read the old
back-end's `contracts/v1` folder (legacy `device_event`, `alert_new`, `alert_seen`, push-token
schemas and fixtures). The cut-over dropped that folder, and the published `@sotercare/contracts`
(1.0.0 to 1.3.0) carries the new platform schemas only. Copying schemas into this repo is against
the platform rules.

| Suite | Why it is out |
|---|---|
| `apps/api-gateway/src/contracts/contracts.spec.ts` | validates legacy wire schemas and checksums |
| `apps/api-gateway/src/notifications/push.unit.spec.ts` | reads the legacy push-token schema |
| `apps/api-gateway/src/realtime/device-event.contract.spec.ts` | validates the legacy `device_event` schema |

Retire or rewrite each against `@sotercare/contracts` when the task that replaces its code (SQS
ingest, push, internal API) lands, and remove its line from the ignore list in the same task.
