# Roll for Brew: Realtime Sync + Persistence Stack

**Date:** 2026-07-22
**Baseline (fixed):** Next.js + TypeScript + Tailwind, deployed on Vercel, real Google OAuth login (personal accounts).
**Scale:** ~10 concurrent users per room, ephemeral rooms (1 day of play), persistent per-user stats across time. Casually maintained by one person.

## Decision framing

Two layers to pick:
1. **Realtime sync** - propagate dice rolls / "I'm in" declarations to everyone in a room, sub-second.
2. **Persistence** - durable per-user stats (rounds lost, cups made, leaderboard) across rooms/time, tied to Google identity.

At 10 concurrent users, every vendor's free tier is wildly oversized for this project - the real differentiators are operational simplicity, auth integration friction, and how cleanly realtime data lands in the durable store, not raw capacity or list-price cost.

---

## Option 1: Supabase Realtime + Postgres (+ Supabase Auth)

- What it is: Postgres-backed BaaS. Realtime supports three modes: Broadcast (pub/sub messages), Presence (who's online), and Postgres Changes (stream table changes over WebSockets). Source: https://supabase.com/docs/guides/realtime
- Cost at 10 users: Free tier includes 200 concurrent realtime connections, 2M realtime messages/month, 500MB database, 50,000 monthly active auth users. Source: https://supabase.com/pricing - a 10-person dice game will never approach these limits; stays on the $0 tier indefinitely.
- Latency: Broadcast messages are direct, server-mediated with latency typically under 50ms. Postgres Changes (via logical replication/WAL) adds roughly 50-200ms and at scale performs one authorization check per subscriber per change, so it doesn't scale well as a primary sync mechanism (irrelevant at 10 users, but shapes the recommended pattern: use Broadcast for the live roll events, Postgres as the durable store). Source: https://supabase.com/docs/guides/realtime/benchmarks
- Auth integration: Supabase Auth has first-party Google OAuth support - configure a Google Cloud OAuth client, add scopes (openid, userinfo.email, userinfo.profile), wire redirect URLs, paste client ID/secret into the Supabase dashboard. Explicitly supports personal (non-workspace) Google accounts via an Audience setting. Source: https://supabase.com/docs/guides/auth/social-login/auth-google
- Persistence integration: The standout point - the realtime layer and the database are the same product. auth.users rows map directly to Postgres tables via foreign keys; Row Level Security policies scope room/stat data to the authenticated user natively. No sync/ETL step between "live event" and "durable stat" - a roll event can be written straight to a Postgres table (durable) and broadcast (live) in the same request.
- Ops burden: Fully managed; no servers to run. One dashboard covers DB + Auth + Realtime.

## Option 2: Pusher Channels

- Cost at 10 users: Free "Sandbox" plan: 100 concurrent connections, 200,000 messages/day. Source: https://pusher.com/channels/pricing/ - comfortably covers 10 users. Next paid tier is $49/month (Startup: 500 connections, 1M msgs/day) if ever needed.
- Latency: Pusher doesn't publish a hard SLA figure on the pricing/docs pages surfaced here; it's a mature pub/sub product built for exactly this (typically sub-100ms in practice), but no primary-source number was found to cite confidently.
- Auth integration: Pusher has no built-in auth/identity product - it only handles channel authentication (a webhook you implement to authorize a client for a private/presence channel). You'd still need NextAuth.js (Auth.js) or Supabase Auth for the actual Google OAuth login, then use that session to authorize Pusher channel subscriptions yourself.
- Persistence integration: None - Pusher is sync-only. Every roll event needs a separate write path into whatever DB you choose (e.g., Neon/Supabase Postgres). That's an extra integration seam that doesn't exist with Supabase Realtime+Postgres.
- Ops burden: Managed, simple SDK, but it's a second vendor/dashboard alongside your DB and auth provider.

## Option 3: PartyKit (Cloudflare)

- What it is: PartyKit was acquired by Cloudflare in April 2024; its runtime (partyserver) is now a library that runs on Cloudflare Workers + Durable Objects, giving each "room" a stateful, in-memory server object addressed by ID. Sources: https://blog.partykit.io/posts/partykit-is-joining-cloudflare/ and https://docs.partykit.io/how-partykit-works/
- Cost: No standalone PartyKit pricing page was found - cost is effectively Cloudflare Workers pricing (Workers has a generous free tier: 100,000 requests/day) since you deploy to your own Cloudflare account. At 10 users this is free.
- Latency: Durable Objects give a single stateful instance per room with in-memory state - very low latency, sub-second by design (edge-hosted, "~50ms of ~95% of the world's internet population" per Cloudflare's edge footprint). Well-suited to a 10-person room seeing the roll instantly.
- Vercel friction: This is the key integration cost - PartyKit/Cloudflare Workers is a separate deployment target from your Next.js app on Vercel. You'd run two deployments (Vercel for the app, Cloudflare for the realtime rooms) and bridge them over WebSocket URLs/HTTP. Workable, but it's a second infrastructure surface for a one-person hobby project.
- Auth integration: No built-in identity - you'd pass a verified session token (from NextAuth/Supabase Auth) to the PartyKit room on connect and verify it server-side yourself.
- Persistence integration: Durable Object state is not your durable stats store - you'd still need to explicitly write roll outcomes to Postgres (or similar) from the Worker, another integration seam.
- Ops burden: Low once set up, but two platforms, two deploy pipelines is real overhead for solo maintenance.

## Option 4: Ably

- Cost at 10 users: Free tier: 200 concurrent connections, 6M messages/month, 500 msgs/sec cap, no credit card required. Source: https://ably.com/pricing - far more than needed. Next tier is $29/month + usage.
- Latency: Ably is positioned as a premium realtime infrastructure provider (guaranteed message ordering, presence, SLA-backed uptime on paid tiers); no specific millisecond figure was surfaced from the pricing page, but sub-100ms is standard for this category.
- Auth integration: Like Pusher, no identity product - supports token-based auth where you mint Ably tokens from your own backend after verifying the user (e.g. via NextAuth + Google), but nothing Google-specific out of the box.
- Persistence integration: None - sync-only, same "second product" seam as Pusher for writing durable stats.
- Ops burden: Managed, well-documented, but again a third vendor alongside your DB/auth choice; feature set (guaranteed ordering, history replay) is more than a 10-person dice game needs.

## Option 5: Plain WebSockets on a custom Node server

- The core problem: Vercel's traditional Serverless Functions never supported long-lived WebSocket connections - you'd need to run a persistent Node process somewhere else (Fly.io, Railway, a VPS) to hold sockets open, splitting your app across two hosts.
- 2026 update: Vercel shipped native WebSocket support in public beta on 2026-06-22 - Vercel Functions can now hold WebSocket connections directly (works with the ws package and Socket.IO, no special config). Source: https://vercel.com/changelog/websocket-support-is-now-in-public-beta
  - Runs on Fluid compute; billing is for active processing time, not idle connection time (same source).
  - Default duration cap: 5 minutes; an extended 30-minute ceiling exists in beta but only on Pro/Enterprise plans with specific runtime versions (same source).
  - A connection is pinned to one Function instance for its lifetime; a new connection isn't guaranteed to hit the same instance, so any cross-connection state (e.g., who else is in the room) needs an external store - Vercel's own guidance recommends Redis from the Vercel Marketplace for this. Source: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Implication for this project: This closes the historical gap, but self-managing raw WebSockets means writing your own connection registry, room fan-out, reconnection/backoff handling, and (per Vercel's own recommendation) standing up Redis just to coordinate presence across function instances - plus the 5-minute default disconnect means routine reconnection logic is mandatory, not an edge case. That's meaningfully more code and more moving parts than any of the managed pub/sub options above, for a project maintained casually by one person.
- Cost: Free tier Vercel Functions usage plus a Redis add-on cost - still cheap at this scale, but not zero-integration.

## Option 6: Vercel's own realtime product

Checked directly rather than assumed: Vercel does not offer a distinct hosted pub/sub "Realtime" product (nothing analogous to Supabase Realtime/Ably/Pusher). What exists in 2026 is the native WebSocket support in Functions described in Option 5 - a transport primitive, not a managed channels/presence service. There is no Vercel-native equivalent to Broadcast/Presence semantics; you'd build that yourself on top of Functions + Redis. Source: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections

Also worth noting: Vercel Postgres was deprecated in June 2025; existing databases were migrated to Neon, and new projects use the Marketplace (Neon, Supabase, or other Postgres providers as integrations) rather than a first-party Vercel database. Source: https://neon.com/docs/guides/vercel-postgres-transition-guide - this rules out "just use Vercel's own DB" as an option; you're choosing a third-party Postgres provider either way, which favors picking one that also gives you realtime and auth for free (i.e., Supabase) rather than picking Neon-for-DB plus a separate realtime vendor.

---

## Comparison summary

| Option | Cost @10 users | Latency | Auth integration | Persistence integration | Ops burden (solo) |
|---|---|---|---|---|---|
| Supabase Realtime+Postgres+Auth | Free indefinitely | Under 50ms (Broadcast) | Native Google OAuth, first-party | Same product, no seam | Lowest - one vendor |
| Pusher Channels | Free (Sandbox) | Good, unpublished figure | None, bolt on NextAuth | Separate DB needed, extra seam | Medium - 2nd vendor |
| PartyKit/Cloudflare | Free (Workers tier) | Very low (edge Durable Objects) | None, bolt on | Separate DB needed, extra seam | Higher - 2 deploy targets |
| Ably | Free | Good, unpublished figure | None, bolt on NextAuth | Separate DB needed, extra seam | Medium - 2nd vendor |
| Custom WebSockets on Vercel | Free to cheap | Good when connected | Bring your own | Bring your own; needs Redis too | Highest - build it all |
| Vercel "realtime" | Doesn't exist as a managed product | N/A | N/A | N/A | N/A |

---

## Recommendation

**Supabase Realtime (Broadcast + Presence) + Supabase Postgres + Supabase Auth (Google OAuth), all in one Supabase project, deployed alongside the Next.js app on Vercel.**

Rationale, tied to the weighted factors:

- Cost: Free tier (200 concurrent connections, 2M realtime messages/month, 50K MAUs) is 20x+ this project's actual scale - stays at $0 indefinitely. Source: https://supabase.com/pricing
- Latency: Broadcast messages run under ~50ms server-mediated - well within "instant reveal" requirements for a dice roll. Source: https://supabase.com/docs/guides/realtime/benchmarks
- Auth integration: This is the deciding factor. Supabase Auth has first-party Google OAuth (including personal, non-workspace accounts) with a documented setup path, and unlike Pusher/Ably/PartyKit, there's no need to hand-roll a second identity layer just to authorize channel subscriptions. Source: https://supabase.com/docs/guides/auth/social-login/auth-google
- Persistence integration: The decisive advantage over every pub/sub-only competitor (Pusher, Ably, PartyKit) - realtime events and durable stats live in the same Postgres database, secured by the same Row Level Security policies keyed to the same authenticated user. A roll event can be persisted and broadcast in one write path instead of stitching together a sync vendor and a separate DB vendor.
- Operational simplicity: One vendor, one dashboard, one set of credentials, for auth + realtime + storage. For a project maintained casually by one person, collapsing three concerns into one managed platform is worth more than any latency or cost delta between the pub/sub specialists, all of which are effectively tied at this scale anyway.

**Strongest runner-up: Pusher Channels (sync) + Supabase or Neon Postgres (persistence) + NextAuth.js (Google OAuth).** This loses mainly on integration surface, not capability - it requires wiring three separate vendors (auth provider, sync provider, DB provider) with your own glue code to keep "live event" and "durable write" consistent, and your own channel-auth webhook to bridge NextAuth sessions into Pusher. Pusher's raw pub/sub latency and reliability are perfectly fine for this use case; it loses purely on "three moving parts vs. one" for a solo-maintained hobby project.

**Explicitly not recommended:** custom WebSockets on Vercel (even with 2026's new native support, it pushes connection-registry, reconnection, and Redis-backed presence coordination onto you - real engineering effort not justified for 10 users), and PartyKit (excellent latency profile, but splits deployment across Vercel + Cloudflare, a second infrastructure surface not worth it at this scale).
