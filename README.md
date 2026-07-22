# roll-for-brew

This is a repo that will replicate a game we have devised in the office where we roll a 20 sided dice to decide who should make tea for the group.

## Stack

Next.js (App Router) + TypeScript + Tailwind, deployed on Vercel. Auth, realtime and persistence all run on a single Supabase project (Postgres + Auth + Realtime) — see [`research/stack-realtime-sync.md`](research/stack-realtime-sync.md) for the decision write-up.

## Auth: Google OAuth + whitelist gate

Login is real Google OAuth via Supabase Auth, restricted to a fixed, server-side whitelist. Non-whitelisted Google accounts are rejected outright at the auth boundary — no `auth.users` row and no session get created for them.

How it's wired (see `supabase/migrations/000{1,2}_*.sql` and `supabase/config.toml`):

- `public.whitelist(email)` — RLS enabled with no policies, so only the service role (or the SQL editor / a migration) can read or write it. There is no path from the app to edit it.
- `public.check_whitelist_before_user_created(event jsonb)` — a Postgres function wired up as Supabase Auth's **Before User Created** hook. It runs once, the first time an identity signs in, before its `auth.users` row is created; if the identity's email isn't on the whitelist it returns an error, which blocks user creation entirely.
- `public.enforce_whitelist_on_access_token(event jsonb)` — a Postgres function wired up as Supabase Auth's **Custom Access Token** hook. Unlike the hook above, this one runs on *every* token issuance (every sign-in, every token refresh), so removing someone from the whitelist actually locks them out on their next login, not just at their very first one.
- `public.players(id, email, display_name, avatar_url)` — kept in sync by an `AFTER INSERT OR UPDATE` trigger on `auth.users` that upserts from the Google profile (`sub`, `email`, `name`, `avatar_url`/`picture`). `id` is the Google `sub`, not the Supabase-generated `auth.users.id`.

## Rooms: auto-creation + roster

There's no manual room creation, code, or link. The first whitelisted login of a calendar day (Europe/London) creates that day's room; every whitelisted login that same day joins the same shared room. The Room tab shows a persistent roster of everyone present that day — name and current modifier, ordered by modifier descending.

How it's wired (see `supabase/migrations/0003_rooms_and_room_players.sql`):

- `public.rooms(id, date unique, created_at)` — one row per calendar day.
- `public.room_players(room_id, player_id, modifier default 0)` — one row per player present in a room, created at room-entry (login), independent of whether they've played a round yet.
- `public.enter_todays_room()` — a `security definer` Postgres function, callable via RPC by any `authenticated` user. It derives the caller's player id server-side from their own `auth.users` row (never from a client-supplied parameter, so a client can only ever enter a room as themselves), computes "today" as `(now() at time zone 'Europe/London')::date`, and idempotently upserts the day's `rooms` row and the caller's `room_players` row (`on conflict do nothing`, so a repeat login the same day joins the existing room without duplicating it or resetting an in-progress modifier).
- The home page (`src/app/page.tsx`, via `src/lib/supabase/rooms.ts`) calls `enter_todays_room()` on every load, then renders the roster by joining `room_players` to `players`, ordered by modifier descending.

## Round lifecycle: start / declare-in / close gating

Any player can start a Round from their own device (auto-enrolling themselves); other present players explicitly declare "I'm in"; only the starter can close declarations, gated on at least 2 declared players. Only one active Round (open or closed, i.e. not yet resolved/cancelled) per Room at a time. This ticket stops at the gated close — no rolling/resolution logic yet (that's a later ticket).

How it's wired (see `supabase/migrations/0004_round_lifecycle.sql`):

- `public.rounds(id, room_id, started_by, status, started_at, resolved_at, brewer_id, cups_made)` — `status` is one of `open | closed | resolved | cancelled` (only `open`/`closed` are reachable so far). A partial unique index on `room_id` where `status in ('open', 'closed')` enforces one active round per room; a second `start_round()` while one is active fails cleanly with a `23505` unique violation.
- `public.round_participants(round_id, player_id, declared_at)` — the declare-in ("I'm in") phase, append-only.
- `public.start_round()` — `security definer` RPC. Opens a round in the caller's room for today and auto-enrolls the caller as its first participant. Caller identity is always derived server-side from `auth.users`, never a client parameter.
- `public.declare_in(p_round_id)` — `security definer` RPC. Idempotently declares the caller in, but only while the round is still `open` and only if the caller already has a `room_players` row in that round's room (i.e. they logged in before or during the round being open) — a player who logs in mid-day is never retroactively added to a round that was already open.
- `public.close_round(p_round_id)` — `security definer` RPC. Only succeeds for the round's `started_by` player, and only once at least 2 players have declared in; otherwise raises an exception.
- The home page (`src/app/page.tsx`, via `src/lib/supabase/rounds.ts`) shows the day's full roster with a "Start round" button when there's no active round, and switches to a live declared-in list — distinct from the full roster — with "I'm in" / "Close declarations" actions once a round is active.

## Stats & leaderboard tab

A top-level Stats tab, alongside Room, with four ranked leaderboards — most cups made, fewest rounds lost ("luckiest"), loss percentage, and highest modifier ever reached — each toggleable between all-time and the last 30 days, plus a per-room history drill-down.

How it's wired (see `supabase/migrations/0006_stats_leaderboards.sql`):

- Every leaderboard is a pair of plain SQL views (`stats_cups_made_all_time` / `_last_30_days`, and similarly for `stats_rounds_lost_*`, `stats_loss_percentage_*`, `stats_modifier_peak_*`), computed live over `rounds`/`round_participants`/`players` — there is no maintained summary table, so the numbers can never drift from the rounds that actually happened. "Lost a round" means being `rounds.brewer_id` on a `resolved` round; "highest modifier ever reached" has no dedicated column (`room_players.modifier` resets to 0 every new room), so it's derived as the running sum of a brewer's `cups_made` across their resolved rounds within one room, ordered by `resolved_at`.
- `stats_room_history` (one row per room/day, resolved-round count) and `stats_room_rounds` (that day's resolved rounds — starter, brewer, cups_made) back the per-room history drill-down.
- All underlying tables are already readable by any authenticated user, so these views need no security-definer wrapper — just `grant select ... to authenticated`.
- `src/app/stats/page.tsx` (via `src/lib/supabase/stats.ts`) renders the four leaderboards and the room drill-down, with the all-time/last-30-days toggle and the room picker driven by the `?window=` / `?room=` query params. `src/app/Nav.tsx` adds the Room/Stats top-level tabs to both pages.

### Local/project setup

1. Create a Supabase project.
2. Run the SQL in `supabase/migrations/` against it (SQL editor, or `supabase db push` if you're using the Supabase CLI).
3. In the Supabase dashboard, enable both the **Before User Created** Auth Hook (pointing at `public.check_whitelist_before_user_created`) and the **Custom Access Token** Auth Hook (pointing at `public.enforce_whitelist_on_access_token`). This mirrors `supabase/config.toml`, which only takes effect for local `supabase start` — the hosted project's hooks are configured in the dashboard.
4. In Google Cloud Console, create an OAuth 2.0 Web application client. Add the Supabase project's callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI, and your app's origin as an authorized JavaScript origin.
5. In the Supabase dashboard's Google provider settings, paste the Google client ID/secret and enable the provider.
6. Add at least one email to `public.whitelist` (via the SQL editor) so you have someone who can actually log in.
7. Copy `.env.example` to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the project's API settings.

### Running the app

```
npm install
npm run dev
```

### Tests

```
npm run typecheck
npm test
```

The integration tests in `tests/integration/` exercise the whitelist gate, the players upsert, and room auto-creation/roster against a real Supabase stack. Two ways to run them:

**Local (Docker) — preferred, no cloud project needed:**

```
npm run test:integration:local
```

This uses the [Supabase CLI](https://supabase.com/docs/guides/local-development) to run a full local Postgres + Auth + Realtime stack in Docker containers — nothing leaves your machine, and there's no disposable cloud project to provision or accidentally point at prod. Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running. The script starts the stack (`supabase start`, which auto-applies `supabase/migrations/` and the Auth Hooks in `supabase/config.toml` — the same hooks the hosted project needs configuring manually for, see step 3 above), reads the generated local URL/keys, and runs `vitest run tests/integration` against them. The stack is left running afterwards for fast repeat runs; stop it with `npm run supabase:stop` when done, or reset its data with `npm run supabase:reset`. Supabase Studio for poking at the local DB is at `http://127.0.0.1:54323` while the stack is up. `project_id` in `config.toml` is pinned to `roll-for-brew` so the stack's fixed ports/containers stay stable regardless of which checkout or worktree you run it from.

Note: `whitelist gate (auth hooks) > rejects a non-whitelisted identity outright` fails against both local and any real Supabase stack — Supabase Auth's Admin API (`auth.admin.createUser`, used as an OAuth stand-in here) intentionally never invokes the Before User Created hook, only the self-service signup/OAuth/OTP paths do. The other whitelist-gate tests (including the revocation one, which goes through a real password sign-in) aren't affected.

**Remote (dedicated cloud test project) — the original setup:**

Set `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` in `.env.test` (see `.env.example`), then run `npm test`. Use a disposable/dedicated Supabase project, never production. The suite is skipped automatically if those aren't set. The test project needs the same migration and Auth Hook configuration as above.

Either way, the revocation test signs in with a password to drive the real token-issuance path the Custom Access Token hook runs on — Google's own OAuth handshake can't be automated in a test.
