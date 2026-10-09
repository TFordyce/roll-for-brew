import type { LastDripPassedOver, LastDripPassedOverReason, LastDripPreview } from "@/lib/supabase/rolls";
import { joinNames } from "@/lib/game/displayName";


const PASSED_OVER_TEXT: Record<LastDripPassedOverReason, (name: string) => string> = {
  absent: (n) => `${n} isn't in this round`,
  roll_exempt: (n) => `${n} is exempt from rolling`,
};

export function passedOverClause(
  passedOver: LastDripPassedOver[],
  displayName: (playerId: string) => string,
): string {
  return joinNames(
    passedOver.map((p) => PASSED_OVER_TEXT[p.reason](displayName(p.playerId))),
    "",
  );
}

export function lastDripNotice(
  preview: LastDripPreview | null,
  displayName: (playerId: string) => string,
): string | null {
  if (!preview) return null;
  if (preview.reason === "no_previous_round") {
    return "There's no previous round, so Last Drip would do nothing.";
  }
  const clause = passedOverClause(preview.passedOver, displayName);
  const later = "This can change if someone declares in or plays a card later this round.";
  if (preview.targetPlayerId === null) {
    const nobody = "nobody from the previous round can currently make tea: Last Drip would do nothing.";
    return clause
      ? `${clause}, so ${nobody} ${later}`
      : `${nobody.charAt(0).toUpperCase()}${nobody.slice(1)} ${later}`;
  }
  if (!clause) return null;
  return `${clause}, so Last Drip would currently name ${displayName(preview.targetPlayerId)} instead. ${later}`;
}
