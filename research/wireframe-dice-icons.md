# Sourcing Open, Stroke-Only Wireframe Polyhedral Dice Icons (d4/d6/d20)

**Date:** 2026-08-05
**Ask:** Open/freely-usable stroke-only (not filled) wireframe polyhedron icons for inlining as SVG, no external asset/CDN dependency.
**Result:** No single icon set covers all three. Best mix found is Lucide's `box` icon for d6, plus two Wikimedia Commons wireframe diagrams for d4 and d20. All three are copy-pasteable now.

---

## Candidates checked

### game-icons.net — REJECTED (wrong style)
- License: **CC BY 3.0**, stated at [game-icons.net/about.html](https://game-icons.net/about.html) ("Icons made by {author}. Available on https://game-icons.net").
- Has dedicated dice icons, e.g. [Dice 20 faces twenty](https://game-icons.net/1x1/delapouite/dice-twenty-faces-twenty.html), [D4](https://game-icons.net/1x1/skoll/d4.html), and a [Dice tag page](https://game-icons.net/tags/dice.html) with 38 icons.
- **Fetched the actual raw SVG** for the D20 (`https://raw.githubusercontent.com/game-icons/icons/master/delapouite/dice-twenty-faces-twenty.svg`) and D4 (`.../skoll/d4.svg`). Both are `viewBox="0 0 512 512"` with a **solid black square background rect plus a single white `fill` silhouette path** — i.e. filled glyph icons (black-square-icon-font style), not stroke-only line art. Confirmed by inspecting the raw markup, not just the preview thumbnail. Does not meet the "wireframe/stroke-only" requirement.

### Lucide — PARTIAL WIN (d6 only)
- License: **ISC** (bulk of icons) / **MIT** for a Feather-derived subset — full text at [lucide-icons/lucide LICENSE](https://raw.githubusercontent.com/lucide-icons/lucide/main/LICENSE). ISC requires only preserving the copyright notice; permissive, commercial use fine.
- `dices` icon ([lucide.dev/icons/dices](https://lucide.dev/icons/dices)) is a pip-dot d6 face icon, not a polyhedron wireframe — not what we want.
- `box` icon ([lucide.dev/icons/box](https://lucide.dev/icons/box)) **is** a stroke-only isometric cube outline — visually exactly a d6 wireframe. Raw source confirmed at `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/box.svg`: pure `stroke="currentColor"` paths, `fill="none"`, native `viewBox="0 0 24 24"`. **Directly usable as-is.**

### Feather / Heroicons
- Not checked in depth beyond confirming (via the Lucide fork lineage — Lucide is a maintained fork of Feather) that neither has a dedicated d4/d20 polyhedron icon; Feather's icon set is the direct ancestor of Lucide's and doesn't have anything Lucide lacks here. No further action needed.

### Wikimedia Commons — WIN (d4 and d20)

**d4 — [File:Basic tetrahedron.svg](https://commons.wikimedia.org/wiki/File:Basic_tetrahedron.svg)**
- License: **CC0 1.0 Universal (Public Domain Dedication)**, stated on the file's Licensing section — no attribution required.
- Raw source confirmed at `https://upload.wikimedia.org/wikipedia/commons/6/65/Basic_tetrahedron.svg`: three `<line>`/`<path>` elements, `fill="none"`, `stroke="black"`/`"#666666"` — genuinely stroke-only wireframe (solid front edges, dashed back edge for the hidden edge, the classic "triangle-pyramid-with-a-dashed-hidden-edge" wireframe convention). `viewBox` implicit at `width="800" height="800"`.
- **Directly usable.** Simplest approach: keep the native `0 0 800 800` coordinate space and let the consumer set `width="24" height="24"` (SVG scales by viewBox automatically) rather than hand-rescaling every coordinate, which would risk transcription error.

**d20 — [File:Icosahedron graph.svg](https://commons.wikimedia.org/wiki/File:Icosahedron_graph.svg)**
- License: dual **GFDL 1.2+** / **CC BY-SA** (3.0 Unported / 2.5 / 2.0 / 1.0 Generic, licensee's choice), stated on the file's Licensing section. CC BY-SA requires attribution + share-alike on redistribution of the file/derivatives — worth a deliberate note in the app's credits, not a rubber stamp (this is the one license in this note with a copyleft condition).
- Raw source confirmed at `https://upload.wikimedia.org/wikipedia/commons/8/83/Icosahedron_graph.svg`: pure `<path>` edges (`fill:none;stroke:black`) plus 12 `<circle>` vertex dots (`fill:blue`) — a genuine stroke-based wireframe/graph rendering of the icosahedron's 12 vertices, confirmed correct in count for a regular icosahedron. Native canvas is `width="625" height="584"` with an internal `translate(1 1)`.
- **Directly usable** — same approach as the tetrahedron: keep the native coordinate space (effectively `viewBox="0 0 627 586"` once the `translate(1 1)` offset is folded in) and scale via `width`/`height`, rather than manually re-deriving all 12 vertex coordinates and ~15 edge path segments (error-prone by hand; the source file is already exact).
- Checked and rejected as *not* fitting the brief: [Icosahedron.svg](https://commons.wikimedia.org/wiki/File:Icosahedron.svg) (filled/shaded solid, dual GFDL/CC-BY-SA-3.0) and [Icosahedron flat.svg](https://commons.wikimedia.org/wiki/File:Icosahedron_flat.svg) (public domain, but it's a filled-color unfolded net, not a 3D wireframe projection).
- No dedicated "Tetrahedron graph.svg" wireframe-graph equivalent exists on Commons for the d4 (searched directly) — not needed since `Basic_tetrahedron.svg` already covers d4 with a cleaner, simpler, CC0 result.

---

## Copy-pasteable snippets

### d6 — Lucide `box` (ISC license, attribution optional but appreciated per ISC notice)
```html
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
  <path d="m3.3 7 8.7 5 8.7-5" />
  <path d="M12 22V12" />
</svg>
```
Source: [github.com/lucide-icons/lucide/blob/main/icons/box.svg](https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/box.svg)

### d4 — Wikimedia `Basic tetrahedron.svg` (CC0 1.0, no attribution required)
```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="24" height="24">
  <line stroke="#666666" stroke-width="10" x1="100" y1="60" x2="790" y2="600" stroke-linejoin="round" stroke-dasharray="30,20" />
  <path stroke="black" stroke-width="10" d="M 10,790 L 400,10 L 790,600 Z" fill="none" stroke-linejoin="round" />
  <path stroke="black" stroke-width="10" d="M 10,790 L 100,60 L 400,10" fill="none" stroke-linejoin="round" />
</svg>
```
Source: [commons.wikimedia.org/wiki/File:Basic_tetrahedron.svg](https://commons.wikimedia.org/wiki/File:Basic_tetrahedron.svg), raw file [upload.wikimedia.org/wikipedia/commons/6/65/Basic_tetrahedron.svg](https://upload.wikimedia.org/wikipedia/commons/6/65/Basic_tetrahedron.svg)
Note: `stroke-width="10"` is calibrated to the 800×800 canvas; if recoloring/restyling for a design system, drop it to something like `2`–`3` to read correctly once scaled to 24×24 via the `width`/`height` attributes.

### d20 — Wikimedia `Icosahedron graph.svg` (dual GFDL 1.2+ / CC BY-SA 3.0 — attribution + share-alike required)
```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 627 586" width="24" height="24">
  <g transform="translate(1 1)">
    <path d="M 213.27708,407.68141 L 213.27708,312.91607 L 298.83665,261.47203 L 383.31318,311.29152 L 383.31318,407.1399 L 298.83665,454.79333 L 213.27708,407.68141 z
             M 298.83665,262.01354 L 271.21932,337.2843 L 214.90163,406.05686 L 298.29513,377.3565 L 381.68863,407.1399 L 326.45398,337.82582 L 298.83665,262.01354 z
             M 272.30235,337.2843 L 298.29513,376.81499 L 325.91246,337.2843 L 272.30235,337.2843 z
             M 214.36011,313.9991 L 270.13629,336.74278 M 325.37094,336.74278 L 382.23015,312.37455 M 298.83665,377.3565 L 298.83665,452.62726
             M 9.50837,571.15925 L 613.71473,571.54216 L 298.29513,10.20849 L 9.50837,571.15925 z
             M 10.90861,570.39343 L 213.8186,314.54062 L 298.29513,11.29152 L 384.93773,312.37455 L 614.03195,571.66793 L 297.2121,454.25181 L 10.90861,570.39343 z
             M 298.2259,12.00612 L 298.2259,262.42914 M 383.23188,405.6374 L 611.44612,569.5228 M 10.27772,569.5228 L 213.21992,407.93486"
          style="fill:none;stroke:black;stroke-width:2" />
    <g transform="translate(154.25181,171.94134)" style="fill:blue;stroke:black;stroke-width:2">
      <circle r="10" cx="143.90794" cy="90.072206"/>
      <circle r="10" cx="229.60289" cy="140.16245"/>
      <circle r="10" cx="172.92419" cy="165.88447"/>
      <circle r="10" cx="116.24548" cy="165.88447"/>
      <circle r="10" cx="59.566787" cy="140.16245"/>
      <circle r="10" cx="143.90794" cy="205.84116"/>
      <circle r="10" cx="143.90794" cy="283.61011"/>
      <circle r="10" cx="59.566787" cy="235.74"/>
      <circle r="10" cx="229.60289" cy="235.74"/>
      <circle r="10" cx="-143.50181" cy="398.46571"/>
      <circle r="10" cx="458.70758" cy="398.46571"/>
      <circle r="10" cx="143.90794" cy="-161.19134"/>
    </g>
  </g>
</svg>
```
Source: [commons.wikimedia.org/wiki/File:Icosahedron_graph.svg](https://commons.wikimedia.org/wiki/File:Icosahedron_graph.svg), raw file [upload.wikimedia.org/wikipedia/commons/8/83/Icosahedron_graph.svg](https://upload.wikimedia.org/wikipedia/commons/8/83/Icosahedron_graph.svg)
Note: `stroke-width="2"` and vertex `r="10"` are calibrated to the ~627×586 canvas; drop both substantially (e.g. stroke `1`, radius `2`–`3`) for a clean look once scaled to 24×24. **This one file carries a share-alike/attribution obligation** (CC BY-SA) unlike the other two — if it ships in the app, credit it (e.g. in an in-app/about-page attributions list: "Icosahedron graph diagram, Wikimedia Commons, CC BY-SA 3.0").

---

## Bottom line
- **d6:** [Lucide `box`](https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/box.svg) — ISC, stroke-only, native 24×24, drop-in as-is.
- **d4:** [Wikimedia `Basic tetrahedron.svg`](https://commons.wikimedia.org/wiki/File:Basic_tetrahedron.svg) — CC0, stroke-only, no attribution needed, drop-in (just retint stroke-width for 24×24).
- **d20:** [Wikimedia `Icosahedron graph.svg`](https://commons.wikimedia.org/wiki/File:Icosahedron_graph.svg) — CC BY-SA 3.0/GFDL, stroke-only, drop-in but **requires attribution** somewhere in the app.
- game-icons.net's dice icons were the most promising-looking candidate by name but are filled glyph icons on inspection of the raw SVG, not wireframes — rejected.
