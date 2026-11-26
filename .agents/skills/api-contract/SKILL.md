---
name: api-contract
description: >-
  Build and test the C#/.NET API under api/, check EF Core migration parity,
  wire flagged TypeScript wrappers, and regenerate the OpenAPI client schema.
  Use when changing endpoints, DTOs, EF Core models, port flags, or running
  dotnet build/test and npm run gen:api.
---

# C# API & OpenAPI Contract

The `.NET` API (`api/RollForBrew.sln`) and TypeScript client types
(`src/lib/api/schema.d.ts`) are checked for drift in CI (`.github/workflows/ci.yml`).

## Steps

1. Build and run all .NET tests (including `Category=EfModel` per ADR 0012):
   ```sh
   dotnet build api/RollForBrew.sln -c Release
   dotnet test api/RollForBrew.sln -c Release --no-build
   ```
2. Regenerate the OpenAPI spec and TypeScript definitions:
   ```sh
   npm run gen:api
   ```
   This updates `api/openapi/RollForBrew.Api.json` and `src/lib/api/schema.d.ts`.
3. Verify TypeScript still compiles and passes tests:
   ```sh
   npm run typecheck
   npm test
   ```
4. Check `git status` and commit `api/openapi/RollForBrew.Api.json` and
   `src/lib/api/schema.d.ts` together with the C# changes so CI's `contract`
   job stays clean.

## Flagged TypeScript wrappers

When adding a new port-flagged wrapper in `src/lib/`, follow the `isPortEnabled`
pattern and unit-test requirements in [docs/port/port-flags.md](../../../docs/port/port-flags.md).
