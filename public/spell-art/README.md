# Spell card art

71 illustrated cards (v2 catalog, migration 0036), one PNG per card, 1024×1024,
committed as delivered — no path/URL column on `spell_cards`; the collection UI
derives each filename from the card's `name` at render time, same convention
the source print-deck tool (`tea-spell-cards-v2.html`) used:

Card name → lowercase → drop apostrophes → every run of non-alphanumeric
characters becomes a single hyphen.

Examples: `Gambler's Infusion` → `gamblers-infusion.png`,
`Genie in the Teapot` → `genie-in-the-teapot.png`, `Milk First?` → `milk-first.png`.

Keeping the mapping derived (rather than stored) means a renamed card doesn't
orphan a stale path — swap in the new file under the new derived name.

## Known follow-up

~62MB across 71 PNGs (avg ~880KB each) — no lossy conversion was applied on
import (no image-conversion tool was available in that session). Worth
revisiting as a webp pass before the collection page ships, if repo/build
size becomes a problem.
