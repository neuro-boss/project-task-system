# Architecture — %PROJECT_NAME%

## System context

- Describe major components and their responsibilities.

## Data ownership

- State which component owns identity, mutable state, financial data, files, jobs, and external callbacks as applicable.

## Critical invariants

- Record rules that must remain true across implementations and migrations.

## Interfaces and flows

- Describe only confirmed boundaries and important event sequences; link detailed integration contracts from `integrations.md`.

## Failure handling

- Define idempotency, retries, timeouts, recovery, and observability expectations.

## Security boundaries

- Record trust boundaries and where authorization, validation, and secret handling occur.
