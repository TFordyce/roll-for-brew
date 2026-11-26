---
name: local-integration-tests
description: >-
  Run or troubleshoot Supabase integration tests under tests/integration/
  against local Docker containers. Use when running integration tests,
  starting, resetting, or stopping the local Supabase stack, or diagnosing
  auth hook and RLS test results.
---

# Local Supabase Integration Tests

Integration tests under `tests/integration/` run against a local Supabase Docker
stack (Postgres + Auth + Realtime) managed by `scripts/test-local.mjs`.

## Prerequisites

- Docker Desktop installed and running.
- Supabase CLI available via devDependencies (`npx --no-install supabase`).

## Steps

1. Start the local stack (if not already running) and execute the integration suite:
   ```sh
   npm run test:integration:local
   ```
   Note: Docker and local loopback access may require running outside the
   terminal sandbox.
2. Manage stack state between runs as needed:
   - Reset database and re-apply migrations: `npm run supabase:reset`
   - Stop containers when finished: `npm run supabase:stop`
   - Local Supabase Studio (while running): `http://127.0.0.1:54323`

## Known behavior

Per [README.md](../../../README.md), `whitelist gate (auth hooks) > rejects a non-whitelisted identity outright`
fails against both local and hosted Supabase stacks because `auth.admin.createUser`
intentionally bypasses the Before User Created hook. Other whitelist-gate tests
(including token revocation via password sign-in) should pass.
