export const STALL_TIMEOUT_MS = 5 * 60 * 1000;

export function hasStalled(since: string, now: Date): boolean {
  return now.getTime() - new Date(since).getTime() >= STALL_TIMEOUT_MS;
}
