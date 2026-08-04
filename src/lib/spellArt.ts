/**
 * Derives a card's illustration path from its catalog name at render time
 * (issue #134, part of the Spell Collection page spec #130) — there's no
 * `art_path` column, so the filenames under `public/spell-art/` (added by
 * PR #125) are named by slugifying `spell_cards.name`: lowercase, drop
 * apostrophes outright (`"Gambler's Infusion"` -> `gamblers-infusion`,
 * `"Fortune's Flavour"` -> `fortunes-flavour`), then collapse every other
 * run of non-alphanumeric characters (spaces, `?`, existing hyphens) into a
 * single `-` (`"Chai-nge of Heart"` -> `chai-nge-of-heart`). Verified
 * against all 72 files in `public/spell-art/`.
 */
export function slugifyCardName(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function spellArtPath(name: string): string {
  return `/spell-art/${slugifyCardName(name)}.png`;
}
