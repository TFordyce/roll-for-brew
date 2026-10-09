# rfb_api role runbook (ticket #535)

Human-only steps for the API's database login. The role itself is created by migration `0157_rfb_api_role.sql`; the password is never in git. Replace `PROJECT_REF` and `PROJECT_ID`. Record results on issue #535.

The grant list is in ADR 0013 (amended by spec #533): `BYPASSRLS`, DML on `public`, `EXECUTE` on still-bridged functions (`current_player_id`), its own `statement_timeout`; no `auth` or `realtime` usage, no `authenticated` membership, no DDL.

## 1. Set the password (once, after 0157 is live on hosted)

- [ ] Confirm the migration is applied: `select rolname, rolbypassrls, rolcanlogin, rolconfig from pg_roles where rolname = 'rfb_api';` (expect `t`, `t`, `{statement_timeout=15s}`).
- [ ] Generate a password (>= 32 chars, URL-safe). In the SQL editor: `alter role rfb_api password '<new>';`
- [ ] Store it in Secret Manager as part of the connection string `rfb-api-postgres-connection-string` (see `gcp-setup-checklist.md` section 3): `Host=aws-0-<region>.pooler.supabase.com;Port=6543;Database=postgres;Username=rfb_api.PROJECT_REF;Password=<new>;SSL Mode=Require;Trust Server Certificate=false`. The API forces `Max Auto Prepare=0`, `No Reset On Close=true`, `Multiplexing=false`, `Maximum Pool Size=5` itself.
- [ ] Do not run `grant`/`alter role` for `auth` or `realtime`; `postgres` cannot, and the design does not want them.

## 2. Verify the login through Supavisor (6543)

- [ ] `psql "postgresql://rfb_api.PROJECT_REF:<pw>@<pooler-host>:6543/postgres?sslmode=require" -c "select current_user, (select rolbypassrls from pg_roles where rolname = current_user)"` returns `rfb_api`, `t`.
- [ ] Same session: `select count(*) from public.players;` works; `select * from auth.users limit 1;` and `create table public.x(i int);` are denied.

## 3. Test password rotation through Supavisor (acceptance criterion)

Background: on #532 Supavisor appeared to keep accepting a dropped role's old password. Do not rely on rotation until this passes.

- [ ] With the current password `P1` working through 6543 (step 2), run `alter role rfb_api password '<P2>';` in the SQL editor.
- [ ] Immediately try `P1` through 6543 on a **new** connection. Expected: rejected. Record whether it was accepted and for how long (retry every 30 s for 10 minutes; note the time it first fails).
- [ ] Try `P2` through 6543 on a new connection. Expected: accepted. Record time to first success.
- [ ] Also try both through the direct connection (5432) as a control.
- [ ] If `P1` is still accepted after 10 minutes, record that, and check whether it clears after a pooler restart or a `pg_terminate_backend` of the role's sessions. Document the working procedure here (below) as the rotation recipe.
- [ ] Rotation recipe, once known (fill in): _e.g. alter role -> add new secret version -> redeploy Cloud Run -> wait N minutes -> verify old rejected_.
- [ ] Update the Secret Manager version to `P2` and redeploy/restart the Cloud Run revision so pooled API connections reconnect (existing pooled connections keep working until they close).

## 4. Hand-off checks after deploy

- [ ] `GET /health/ready` is 200 on Cloud Run (schema gate sees 0157).
- [ ] `GET /acting-as` with a real signed-in admin's access token returns `{"actingAsPlayerId": null}` (or the pointer), and 401 problem+json with no token.
