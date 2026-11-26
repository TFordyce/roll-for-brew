# Roll for Brew — Agent Instructions

## Workflows & conventions

- **Issue tracker**: GitHub issues in `TFordyce/roll-for-brew` via the `gh` CLI. Read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) before creating, reading, labelling, or linking issues.
- **Triage labels**: Canonical vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- **Domain docs**: Read [GLOSSARY.md](GLOSSARY.md) and relevant ADRs in `docs/adr/` before exploring or naming domain concepts. See [docs/agents/domain.md](docs/agents/domain.md).
- **Parallel isolation**: Keep parallel sessions in separate working trees—either a manual git worktree ([docs/agents/worktrees.md](docs/agents/worktrees.md)) or an Antigravity isolated workspace (`share` / `branch`).

## Repo-specific checks & gotchas

- **TypeScript verification**: Run `npm run typecheck`, `npm test`, and `npm run verify:migrations`. (`npm run lint` is currently broken because ESLint 9 has no `eslint.config.*`; CI omits it.)
- **Resolver SQL functions**: Canonical source lives in `db/sql/functions/` and migrations are generated. Use the `resolver-migrations` skill when editing stored functions.
- **C# API & OpenAPI contract**: Changes under `api/` must build, pass `dotnet test api/RollForBrew.sln -c Release`, and stay in sync with `api/openapi/RollForBrew.Api.json` and `src/lib/api/schema.d.ts` via `npm run gen:api`. Use the `api-contract` skill when changing the API or flagged TS wrappers.
- **Local integration tests**: Use the `local-integration-tests` skill when running `tests/integration/` against local Supabase + Docker.
- **Dev server**: `npm run dev` serves on port 3000. In Antigravity on Windows, launch it outside the sandbox if you need browser access from the host.
