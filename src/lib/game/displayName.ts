export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

export function firstNameOrFallback(displayName: string | null, fallback: string): string {
  return displayName === null ? fallback : firstName(displayName);
}

export function joinNames(names: string[], emptyFallback: string): string {
  if (names.length === 0) return emptyFallback;
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
