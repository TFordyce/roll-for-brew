# Issue #82 — Tavern Backdrop Implementation Plan

**Status:** Assets finalized and in place. Wiring (code) not yet started.
**Handoff context:** this doc exists so a fresh session can implement without re-deriving the design decisions made in chat. Read this fully before writing code.

---

## What this replaces

The current wood-plank placeholder from issue #64:
- `src/app/globals.css:6-18` — `.bg-wood-planks` class, tiles `public/wood-planks.png` at 256x256 with `image-rendering: pixelated`.
- Applied in: `src/app/page.tsx` (Room + roll/reveal/tie phases), `src/app/Nav.tsx`, `src/app/stats/page.tsx`, `src/app/settings/page.tsx`, `src/app/_components/RankRow.tsx`, `src/app/_components/PlayerTile.tsx`.
- Out of scope: `CardFrame`, `PlayerTile` internals, screen layouts — this is backdrop-only.

## Design decisions made (do not re-litigate these)

1. **Scene concept:** not a tavern room — a **tea/coffee counter viewed side-on**, single full-bleed scene, `background-size: cover`, **no tiling/repeat** (unlike the old wood-planks texture).
2. **Two-layer parallax:** back layer (counter/wall) + foreground props layer, both shift on mouse move, foreground shifts more than background (standard parallax depth cue).
3. **8 shuffled prop slots**, not a fixed composition. Props: kettle, teapot, mug rack (5 hooks... actually generated with 4 cups, confirmed fine, no regen needed), sugar bowl, milk carton, instant coffee jar branded "Roll4Brew", tea towel (draped over counter edge), stack of saucers. All 8 are shuffled across slots — nothing is fixed backdrop decor.
4. **Shuffle mechanics:** seeded PRNG (e.g. mulberry32), seed = hash of `` `${playerId}-${YYYY-MM-DD}` ``. Same user sees a stable layout all day; changes daily; different users can see different layouts. `playerId` is already available in `src/app/page.tsx:34`. Fisher-Yates shuffle the 8 prop→slot assignments with this seed.
5. **Steam:** kettle occasionally puffs steam. Frequency default (maintainer's call, not user-specified): random interval ~45-90s, one 2-3s puff per trigger, then hides. Steam sprite must render at wherever the shuffle placed the kettle that day (look up kettle's current slot at render time — never hardcode a slot).
6. **Motion accessibility:** respect `prefers-reduced-motion: reduce` — disable parallax transform and/or steam animation for users who've opted out.
7. **Perf:** parallax transform must use `transform: translate3d(x, y, 0)` (GPU-accelerated), throttled via `requestAnimationFrame`, never animate `top`/`left`.
8. **Palette reference** (from `tailwind.config.ts`): `tavern.plank #4a3222`, `tavern.plank-dark #3a2718`, `tavern.panel #2a1e14`, `tavern.panel-dark #1c130c`, `gilt DEFAULT #c9a54a`, `gilt.bright #e8ce8f`, `gilt.dark #8a6a2c`, `parchment DEFAULT #f1e6cf`, `parchment.dim #c9bda3`, `ember DEFAULT #7a3b2e`, `ember.bright #b3543f`.

## Assets — finalized, verified, in place

Location: `public/backdrop/`

```
public/backdrop/back-layer.png              — counter/wall scene, no repeat, background-size: cover
public/backdrop/props/kettle.png            — steam-capable prop
public/backdrop/props/teapot.png
public/backdrop/props/mug-rack.png          — 4 cups (confirmed fine as-is)
public/backdrop/props/sugar-bowl.png
public/backdrop/props/milk-carton.png
public/backdrop/props/coffee-jar.png        — "Roll4Brew" branded, styled after Nescafe jar
public/backdrop/props/tea-towel.png
public/backdrop/props/saucer-stack.png
public/backdrop/steam/steam-1.png … steam-5.png   — 5-frame puff→dissipate loop, transparent, aligned bottom-center anchor
```

All assets have been visually verified (pixel-cropped and inspected): transparent backgrounds are clean, no leftover watermarks/registration marks, consistent scale. `assets/tavern-backdrop-source/` retains the raw/intermediate generation files (including `*-raw.png` originals and the stitched `steam-sheet.png`) for reference — not needed for the app, don't wire those in directly.

**Slot geometry note:** these are individual transparent PNGs, not a pre-composed layer. The 8 slot x-positions along the counter (side-on view) still need to be defined in code — pick 8 evenly-spaced x-anchors that make sense against `back-layer.png`'s actual counter surface (open the image to eyeball counter-top y-position and left/right bounds).

## Code plan

1. **Shuffle utility** (e.g. `src/lib/backdropShuffle.ts`):
   - `mulberry32(seed: number)` PRNG.
   - Hash `playerId + date` string to a numeric seed (simple string hash is fine, doesn't need cryptographic strength).
   - Fisher-Yates shuffle an array of the 8 prop keys against 8 slot indices.
   - Export a function like `getSlotAssignments(playerId: string, date: Date): Record<SlotIndex, PropKey>`.

2. **`ParallaxBackdrop` component** (e.g. `src/app/_components/ParallaxBackdrop.tsx`):
   - Client component (`"use client"`).
   - Renders a container `div` (`overflow: hidden`, positioned behind content, z-index below `CardFrame`).
   - Back layer: `<img src="/backdrop/back-layer.png">` or CSS background, `background-size: cover`, `image-rendering: pixelated`.
   - Foreground layer: absolutely-positioned wrapper containing the 8 prop `<img>`s at their shuffled slot positions.
   - `onMouseMove` (window-level) computes cursor offset from viewport center, normalized to small px ranges — back layer ±8px, foreground layer ±20px (foreground moves more, per parallax convention decided above).
   - Apply via `transform: translate3d(x, y, 0)`, rAF-throttled.
   - `prefers-reduced-motion: reduce` media query (via CSS or `matchMedia` in JS) disables the transform.
   - Takes `playerId` as a prop (already available in `page.tsx`).

3. **Steam trigger:**
   - Small sub-component or hook, e.g. `useKettleSteam()`.
   - `setInterval`/timer with randomized 45-90s delay; on fire, cycle through `steam-1.png`…`steam-5.png` via `steps(5)` over ~2-3s (CSS animation or JS-driven frame index), then hide, then reschedule.
   - Position: absolutely positioned over the kettle's current slot (look up from the shuffle assignment, not hardcoded).
   - Also gated by `prefers-reduced-motion` — either skip entirely or show a static/no-op state.

4. **Wire into call sites:** replace `.bg-wood-planks` usage in `src/app/page.tsx`, `Nav.tsx`, `src/app/stats/page.tsx`, `src/app/settings/page.tsx`, `RankRow.tsx`, `PlayerTile.tsx` with `<ParallaxBackdrop playerId={playerId} />` rendered behind existing content.

5. **Cleanup:** once nothing references `.bg-wood-planks`, remove it from `globals.css` along with its issue-#64 placeholder comment. Leave `public/wood-planks.png` alone unless confirmed unused elsewhere (grep first).

## Verification checklist (after implementation)

- [ ] Visual check on every screen: Room, roll/reveal/tie phases, Nav, Stats, Settings.
- [ ] Shuffle is stable within a day for one user, changes the next day (can fake by adjusting system date or the seed function directly in a test).
- [ ] Two different `playerId`s produce different (or at least independently-seeded) layouts.
- [ ] Parallax feels subtle, not disorienting; card-frame content stays legible over the busier scene.
- [ ] Kettle's steam always appears at the kettle's actual current slot, not a stale/hardcoded position.
- [ ] `prefers-reduced-motion: reduce` (test via devtools emulation) disables parallax movement and steam animation.
- [ ] No layout shift / overflow scroll issues from translated layers peeking past viewport edges.
- [ ] Performance: rAF-throttled transform doesn't visibly jank on a mid-range machine.

## Open items nobody has decided yet (flag if they come up, don't silently assume)

- Exact steam frequency/timing is the maintainer's placeholder guess (45-90s / 2-3s), not user-specified — fine to tune post-launch.
- Exact 8 slot x-positions along the counter are not yet chosen — need to be picked against the actual `back-layer.png` art during implementation.
