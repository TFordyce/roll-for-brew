# The API connects as a dedicated BYPASSRLS role and is the sole authorizer; PostgREST closes

## Status

accepted — 2026-10-08. Decided on the C# port map ([#476](https://github.com/TFordyce/roll-for-brew/issues/476)): [Decide Supabase JWT auth and Acting As in the API](https://github.com/TFordyce/roll-for-brew/issues/481), amended by [Decide the end state of RLS and rpc grants](https://github.com/TFordyce/roll-for-brew/issues/496), using facts from [Research: Supabase role for the API's own SQL past RLS](https://github.com/TFordyce/roll-for-brew/issues/501). ADR 0001 (Acting As via `current_player_id`, never client-supplied) stands unamended.

## Decision

- **Identity stays Supabase Auth.** The API validates the Supabase JWT itself (issuer, audience, expiry), via JWKS with keys cached. If the project still signs with legacy HS256, either migrate it to asymmetric keys first or configure the shared secret. The design is the same either way.
- **The API's database identity is a dedicated `rfb_api` login role.** It connects through the Supavisor transaction pooler (6543) as `rfb_api.<project-ref>`. The role has:
  - `BYPASSRLS`;
  - DML on `public`, plus default privileges on objects `postgres` creates;
  - `usage on schema realtime` and `insert on realtime.messages`;
  - `grant authenticated to rfb_api`, for `current_player_id` execute and `auth` schema usage;
  - its own `statement_timeout`;
  - no DDL, and no writes to `auth`.

  A migration creates it. The password is set by hand on hosted and kept in GCP Secret Manager, never in git.
- **Claims bridge.** Every transaction runs `set_config('request.jwt.claims', <validated claims>, true)`, so `auth.uid()` and `current_player_id()` keep working for SQL bridges and unported RPCs. The API does **not** `set local role authenticated`: its own SQL must see the whole room. Ported endpoints call SQL `current_player_id` for Acting As until the last SQL caller is gone.
- **.NET is the sole authorizer.** Game-secrecy rules (holder-only hands and draws, rolls hidden until resolved, rater-only ratings) live in C#, mostly in the room-view screen model, and are pinned by tests.
- **End state:**
  - PostgREST is closed: the browser keeps only `supabase.auth` and realtime broadcast.
  - Grants and policies are revoked per slice as each table's last PostgREST reader or writer ports. The consolidation slice sweeps the rest and revokes default function `execute` in `public`.
  - CI fails if `anon` or `authenticated` hold any `public` grant.
  - RLS stays **enabled with no policies**, which denies `anon` and `authenticated` by default.
  - The Data API is switched off once a test project shows Auth and Realtime still work without it.

## Considered

- **`set local role authenticated` for all API SQL** (the original bridge). Rejected: RLS would hide other players' deck instances, draws, unresolved rolls and ratings from the snapshot, and almost every write would fail, since policies are select-only.
- **Connect as `postgres`.** Rejected: the web tier would get DDL and role rights, and share a password with migrations.
- **`set local role service_role`.** Rejected: from 2026-10-30, `service_role` stops getting automatic DML grants on new tables, and it is coupled to the Data API's key role.
- **A non-bypass role with `using (true)` policies on about 29 tables.** Rejected: same access as BYPASSRLS, but with drift risk and lint 0024 noise.
- **Drop RLS entirely.** Rejected: enabled RLS with no policies is a free deny-by-default if a grant is ever restored by mistake.

## Consequences

- Through the strangler, unported RPCs still run as `authenticated` from the browser, so their RLS and grants stay live until their slice.
- `realtime.send` as `rfb_api` must be proven on hosted in slice 0, along with the pooler login and the `BYPASSRLS` grant.
- Moving identity to Entra would be a separate effort, outside the port.
