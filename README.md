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
