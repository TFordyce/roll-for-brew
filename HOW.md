# HOW: re-creating the shared-dice captures for PR #615

These four images were produced on 2026-11-04 from branch
`spec/607/shared-dice-playback` (the three commits for #612, #607 and #613).

**They are a component harness, not a live authenticated room.** There is no
Supabase session, no C# API, no round, and no game state behind them. What *is*
real is the rendering: the dice faces, the throw tracks, the collision bodies
and the slot layout are produced by the shipped components and the shipped
physics, not by a mock-up. Only the room around them is fixture data.

## What is real

```text
src/app/_components/ParallaxBackdrop.tsx   the shipped scene and props
src/app/rounds/DiceTable.tsx               the shipped table, slots and dice
src/app/rounds/DieFaces.tsx                the shipped CSS d20
src/lib/game/diceTable.ts                  the shipped layout maths
src/lib/game/diceSeeds.ts                  the shipped derived throw tracks
src/lib/game/dicePhysics.ts                the shipped cannon-es simulation
src/app/_components/CardFrame.tsx          the shipped card
src/app/_components/DieIcon.tsx            the shipped wireframe icon
```

## What is fixture

- Four participants (`Alex 14`, `Sam 9`, `Rowan 17`, `Mo 6`) with fixed values.
- The `Rolling` card's rows, assembled to mirror `RoundReveal`'s markup: a
  modifier, a name, the static `DieIcon` + value in its fixed slot, and the
  total badge. `RoundReveal` itself was not used because it opens a Supabase
  channel on mount.

## The two states

- **settled** — `DiceTable` with `owesThrow: false`, i.e. every die rendering its
  settled face. This is the end state of the reveal.
- **throw** — `DiceTable` with `owesThrow: true`, so every die mounts with the
  batch and plays its derived track. The page pauses every Web Animation at
  760 ms, which is what makes a still frame of the throw possible: headless
  screenshots do not advance the animation timeline themselves.

## Reproducing

1. Add a temporary route (never committed) rendering the fixture harness:

   ```text
   src/app/preview/shots/page.tsx       settled
   src/app/preview/shots/fly/page.tsx   throwing, honours ?freeze=<ms>
   ```

   `/preview/*` is on the middleware's public path list, so no login is needed.

2. Disable the Next dev badge for the captures (`devIndicators: false` in
   `next.config.mjs`), then revert it.

3. `npx next dev -p 3101`

4. Capture, with a fresh `--user-data-dir` per run — reusing one makes Chrome
   attach to an already-running instance and screenshot the wrong window:

   ```text
   chrome --headless=new --disable-gpu --no-sandbox \
          --force-device-scale-factor=2 --user-data-dir=<fresh> \
          --window-size=1440,900 --virtual-time-budget=9000 \
          --screenshot=desktop-settled.png http://127.0.0.1:3101/preview/shots

   chrome ... --window-size=1440,900 ... --screenshot=desktop-throw.png \
          "http://127.0.0.1:3101/preview/shots/fly?freeze=760"

   chrome ... --window-size=500,900  ... --screenshot=narrow-settled.png \
          http://127.0.0.1:3101/preview/shots

   chrome ... --window-size=500,900  ... --screenshot=narrow-throw.png \
          "http://127.0.0.1:3101/preview/shots/fly?freeze=760"
   ```

5. Delete the temporary route and restore `next.config.mjs`.

## Why the narrow capture is 500px, not 390px

Headless Chrome on Windows clamps its window width to roughly 500px. Asking for
390px lays the page out at ~500px and then screenshots only the left 390px, which
looks like a horizontal overflow that isn't there — the unmodified `/preview`
page clips in exactly the same way. 500px is below Tailwind's `sm` breakpoint
(640px), so it still shows the stacked narrow layout.
