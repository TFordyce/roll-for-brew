
export function isReactionWindowClosed(eligiblePlayerIds: string[], passedPlayerIds: string[]): boolean {
  const passed = new Set(passedPlayerIds);
  return eligiblePlayerIds.every((id) => passed.has(id));
}

