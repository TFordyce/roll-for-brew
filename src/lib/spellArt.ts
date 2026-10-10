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
