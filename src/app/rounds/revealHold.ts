import type { RoundRevealParticipant } from "./RoundReveal";

export type HeldReveal = { roundId: string; participants: RoundRevealParticipant[] };

export function shouldClearRevealHold(
  activeRoundId: string | null | undefined,
  heldRoundId: string | null | undefined,
): boolean {
  return activeRoundId != null && heldRoundId != null && activeRoundId !== heldRoundId;
}
