import { firstNameOrFallback } from "@/lib/game/displayName";
import { type MenuEntry } from "@/lib/supabase/menu";
import { CardFrame } from "@/app/_components/CardFrame";

export type RoundMenuParticipant = {
  playerId: string;
  displayName: string | null;
  email: string;
};

/**
 * The live Menu (issue #227, part of #223): who wants what this round, with
 * milk/sugar pulled from each orderer's current Usual. A plain server-
 * rendered list — entries and participant names both arrive as props,
 * already resolved by the caller (page.tsx/admin/test-room's page.tsx) via
 * getRoundMenu + getRoundParticipants, the same "server component owns the
 * data, MenuLive.tsx just triggers a refetch" split RoundOpenLive/
 * SpellCastLive already use elsewhere on this page.
 *
 * Only ever contains this round's declared participants who have an Order
 * (round_menu's own round_participants join, 0062) — a participant with no
 * Order simply isn't in `entries`, no explicit "no drink" row (user story
 * 18). Renders nothing (not even the frame) when there's nobody to list yet,
 * so an empty Menu doesn't sit on the page before the first Order comes in.
 */
export function RoundMenu({
  entries,
  participants,
}: {
  entries: MenuEntry[];
  participants: RoundMenuParticipant[];
}) {
  if (entries.length === 0) return null;

  const participantById = new Map(participants.map((p) => [p.playerId, p]));

  return (
    <CardFrame title="Menu" className="mt-4">
      <ul className="divide-y divide-gilt-dark/40">
        {entries.map((entry) => {
          const participant = participantById.get(entry.playerId);
          const name = firstNameOrFallback(
            participant?.displayName ?? null,
            participant?.email ?? entry.playerId,
          );
          return (
            <li key={entry.playerId} className="flex items-center justify-between gap-3 py-2">
              <span className="font-body text-sm text-parchment">{name}</span>
              <span className="font-body text-xs text-parchment-dim">
                {entry.drinkType === "tea" ? "Tea" : "Coffee"}
                {entry.noPreferenceSet ? (
                  <span className="ml-1.5 text-gilt">— no preference set</span>
                ) : (
                  <span className="ml-1.5">
                    — {entry.milk}, {entry.sugar}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </CardFrame>
  );
}
