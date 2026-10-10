
export function isReactionWindowClosed(eligiblePlayerIds: string[], passedPlayerIds: string[]): boolean {
  const passed = new Set(passedPlayerIds);
  return eligiblePlayerIds.every((id) => passed.has(id));
}

export type ReactionStackEntry = {
  castId: string;
  seq: number;
  parentCastId: string | null;
};

export function orderStackForResolution<T extends ReactionStackEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}
