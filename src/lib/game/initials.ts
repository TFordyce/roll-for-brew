/**
 * Turns a display name (or, lacking one, an email) into the short signed
 * initials shown on the Brew Rating panel's stamp (issue #211) — e.g. "Tom
 * Fordyce" -> "T.F.". Same displayName-or-email fallback shape as
 * displayName.ts's firstNameOrFallback, but not built on it — that helper
 * returns a readable name, this one needs single letters, so the fallback
 * check is re-done here rather than composed.
 */
export function initialsFrom(displayName: string | null, email: string): string {
  const source = displayName?.trim();
  if (source) {
    return source
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => `${word[0]!.toUpperCase()}.`)
      .join("");
  }
  const localPart = email.split("@")[0]?.trim();
  return localPart ? `${localPart[0]!.toUpperCase()}.` : "";
}
