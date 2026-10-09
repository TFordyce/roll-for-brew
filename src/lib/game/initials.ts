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
