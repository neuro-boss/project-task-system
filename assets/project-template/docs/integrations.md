# Integrations — %PROJECT_NAME%

Create one section per external system.

## Integration template

- **Purpose:** Why the project uses it.
- **Owner:** Which internal component owns communication.
- **Authentication:** Environment-variable names or secret locations only; never values.
- **Data sent and received:** Minimum required fields and prohibited data.
- **Idempotency and retries:** Duplicate handling, timeout, retry, and terminal failure rules.
- **Environments:** Confirmed sandbox, staging, and production differences.
- **Verification:** Safe health or contract checks that have actually been confirmed.
