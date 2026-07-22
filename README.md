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

The integration tests in `tests/integration/` exercise the whitelist gate, the players upsert, and room auto-creation/roster against a **real, dedicated Supabase test project** (never production) — set `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` in `.env.test` (see `.env.example`). The suite is skipped automatically if those aren't set. The test project needs the same migration and Auth Hook configuration as above (the revocation test signs in with a password to drive the real token-issuance path the Custom Access Token hook runs on — Google's own OAuth handshake can't be automated in a test).
