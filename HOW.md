# HOW: re-running the app and staging the spec #600 dice captures

These are the exact steps used on 2026-10-27 to produce `tumble.png`, `landed.png`,
`dismissed.png`, `reduced-tumble.png` and `reduced-landed.png` for PR #604
(feature branch `spec/600-3d-in-row-dice` @ `30a077b31`, worktree
`C:\Users\tomfo\repos\roll-for-brew\.claude\worktrees\spec600-integration`).

The app at that commit always renders room pages from the C# API
(`GET /rooms/{id}/view`, migration `0161`), so a local run needs **three**
processes: the Supabase Docker stack, the .NET API, and `next dev`.

## 0. Prerequisites

- Docker Desktop running.
- .NET SDK 10.x (`dotnet --version` — repo pins `10.0.100` rollForward latestFeature).
- Node 18+ and the repo's `node_modules` already installed in the worktree.

## 1. Start the local Supabase stack (from the worktree)

```
cd C:\Users\tomfo\repos\roll-for-brew\.claude\worktrees\spec600-integration
npx supabase start        # project_id is pinned to `roll-for-brew` in config.toml, ports are stable
npx supabase db reset     # applies all supabase/migrations/* incl. 0024 (Test Room + 4 test players)
npx supabase status -o env  # note API_URL (http://127.0.0.1:54321), ANON_KEY, SERVICE_ROLE_KEY
```

The stack's local GoTrue publishes an ES256 JWKS at
`http://127.0.0.1:54321/auth/v1/.well-known/jwks.json` — the API needs it.

## 2. Worktree `.env.local` (gitignored; create it, pointing at the local stack)

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from supabase status>
NEXT_PUBLIC_API_URL=http://127.0.0.1:5152
```

## 3. One-line local patch to the C# API (revert after!)

`api/src/RollForBrew.Api/Auth/JwksSource.cs` hardcodes
`HttpDocumentRetriever { RequireHttps = true }`, which rejects the local stack's
http-only JWKS URL (no documented local recipe exists). For the run, change that
one line to allow loopback http:

```csharp
new HttpDocumentRetriever(http ?? new HttpClient()) { RequireHttps = !jwksUrl.StartsWith("http://127.0.0.1") && !jwksUrl.StartsWith("http://localhost") }
```

**Revert with `git checkout -- api/src/RollForBrew.Api/Auth/JwksSource.cs` when done.**

## 4. Run the C# API (room view + advance endpoints)

```
cd C:\Users\tomfo\repos\roll-for-brew\.claude\worktrees\spec600-integration
env POSTGRES_CONNECTION_STRING='Host=127.0.0.1;Port=54322;Database=postgres;Username=postgres;Password=postgres' ^
    JWT_ISSUER='http://127.0.0.1:54321/auth/v1' ^
    JWKS_URL='http://127.0.0.1:54321/auth/v1/.well-known/jwks.json' ^
    CORS_ORIGINS='http://localhost:3000,http://127.0.0.1:3000' ^
    ASPNETCORE_URLS='http://127.0.0.1:5152' \
    dotnet run --project api/src/RollForBrew.Api --no-launch-profile
```

Check: `curl http://127.0.0.1:5152/health/ready` → `{"status":"ok","gate":"disabled"}`.

## 5. Seed a local admin login (Google OAuth isn't available locally)

The app's only login is Google OAuth, and the Test Room needs an admin.
`scripts/seed.mjs` (kept next to this file, run from the worktree so
`@supabase/supabase-js` + `@supabase/ssr` resolve) does everything with the
service-role key:

1. Upserts `dev-admin@rollforbrew.test` into the RLS-locked `whitelist`.
2. `auth.admin.createUser` with password `dev-admin-pass-001`, `email_confirm`,
   `user_metadata: { sub: "dev-admin-player", name: "Dev Admin" }` (the Admin API
   bypasses the before-user-created whitelist hook; the players trigger mirrors
   the `sub` into `public.players.id`).
3. Upserts the `players` row with `is_admin = true`.
4. Signs in with `signInWithPassword` through `createServerClient` from
   `@supabase/ssr` using a memory cookie store, and writes the resulting browser
   cookie (`sb-127-auth-token`, ~2.7 KB base64 session JSON) to
   `session-cookies.json`.

## 6. Run the app

```
cd C:\Users\tomfo\repos\roll-for-brew\.claude\worktrees\spec600-integration
npm run dev    # http://localhost:3000
```

## 7. Sign in and open the Test Room

The session cookie is not httpOnly, so on any `http://localhost:3000` page set
it with `document.cookie` (plus the admin-mode cookie), then navigate:

```js
document.cookie = "sb-127-auth-token=<value from session-cookies.json>; path=/; max-age=34560000; samesite=lax";
document.cookie = "admin_mode=true; path=/; max-age=34560000; samesite=lax";
location.href = "/admin/test-room";
```

`canAccessTestRoom` needs `is_admin` (players table) + the `admin_mode` cookie.

## 8. Stage a round in the Test Room (all clicks in the UI)

1. "Acting As" → **Test Player 1** (admin puppeting via `set_acting_as`).
2. **Start Round** (auto-enrolls TP1 as starter).
3. Acting As → **Test Player 2** → **I'm in**.
4. Acting As → **Test Player 1** → **Let's roll** (closes declarations; 2 participants).
   The "Rolling" frame appears with both rows showing "?" — this is where the die lives.
5. Click **Roll** (the first Roll button — TP1's in-app d20 form, `roll_input_mode`
   defaults to `in_app_only`): `die.rollSubmitted()` fires on submit and the CSS-3D
   die starts tumbling in TP1's own row (1.6 s loop). `tumble.png` is a mid-tumble
   frame taken ~0.6 s after the click; two more frames 0.4 s apart confirmed motion.
   TP2 has not rolled, so the layer is incomplete and the die keeps tumbling.
6. Roll **Test Player 2** via the "Roll For" panel (manual value input, e.g. 7):
   the server action runs `advance_round`, the layer completes, and the
   `layer-rolls-revealed` + `round-revealed` realtime broadcasts (local Realtime,
   `channel.httpSend`) land the die on TP1's actual rolled value. If TP1 is the
   brewer a "Get the kettle on" modal covers the page — click **Show results**
   to dismiss. `landed.png`: TP1's row shows the landed die, TP2's row shows the
   wireframe icon + recap expression.
7. Click the landed die ("Back to the roll row") → row reverts to the standard
   recap presentation → `dismissed.png`.

Gotchas learned the hard way:

- The closed-round **stall timeout (5 min)** force-resolves a stalled round and
  wipes the die — don't dawdle between step 5 and 6 (one take was lost to this).
- A 12-12 tie opens a tie-break layer that has no die — delete the round via
  Admin → Rounds (or `admin_delete_round` RPC) and restage.
- The acting-as switcher / close buttons are server-action forms; a click issued
  while a previous action is still in flight can be swallowed. Verify each step
  landed (button appears / heading changed) before the next click.

## 9. Reduced-motion captures (`prefers-reduced-motion: reduce`)

The ZCode in-app browser exposes no CDP emulated-media, and the Windows-level
`SystemParametersInfo(SPI_SETCLIENTAREAANIMATION)` toggle refused to stick in
this session, so real emulation was not possible. A **page-level simulation**
was used instead, which reproduces exactly what the media query does for this
feature (`useReducedMotion` in `src/lib/hooks/useReducedMotion.ts` subscribes to
`(prefers-reduced-motion: reduce)` change events; Tailwind's `motion-reduce:`
variant compiles to the same `animation: none` rule):

```js
// 1. flip the hook the app itself listens to
window.matchMedia("(prefers-reduced-motion: reduce)")
  .dispatchEvent(new MediaQueryListEvent("change", { matches: true }));
// 2. apply the identical CSS the motion-reduce:animate-none variant applies
const s = document.createElement("style");
s.textContent = ".animate-die-tumble { animation: none !important; }";
document.head.appendChild(s);
```

With this in place: after step 5 the die is a static held die
(`reduced-tumble.png` — the animation class stays but runs nothing, exactly the
`motion-reduce` presentation); after step 6 the die appears statically with the
value and no landing animation (`reduced-landed.png`, `entrance: "static"`).

Treat these two as a faithful-but-simulated variant, not a browser-emulated one:
the JS-visible behavior is identical, but real emulation would also apply
`motion-reduce:` variants anywhere else in the app.

## 10. Screenshots

Viewport 1100x1600, clipped to the "Rolling" CardFrame's bounding rect
(+8/+40 px margins) so the reveal rows fill the frame. Shots were taken via
Playwright `tab.screenshot({ clip })` in the ZCode in-app browser.
