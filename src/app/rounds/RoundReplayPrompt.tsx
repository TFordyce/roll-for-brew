"use client";

import { useRouter } from "next/navigation";
import { useRoomChannel } from "@/lib/supabase/useRoomChannel";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { confirmRoundReplayAction, declineRoundReplayAction } from "@/app/rounds/actions";

/**
 * The Round Replay decision surface — Time for Brew (issue #315, spec #302
 * §11). A surviving Time for Brew resolves and announces its round normally,
 * then this appears:
 *
 *  - the caster gets a blocking modal (matching TieRollModal's shape) — scrap
 *    the round and replay from a clean slate, or keep the announced result;
 *  - everyone else gets a non-blocking banner naming who the table is waiting
 *    on, since start_round is locked for the whole room until the decision is
 *    made (or the existing 5-minute closed-round stall timer auto-declines it).
 *
 * page.tsx only mounts this while get_room_pending_round_replay returns a row,
 * so there is no "nothing pending" state to render. The realtime listener
 * refreshes the server tree when the decision is confirmed / declined /
 * auto-declined on another device, or when the generation-1 round opens.
 */
export function RoundReplayPrompt({
  roomId,
  roundId,
  isCaster,
  casterDisplayName,
}: {
  roomId: string;
  roundId: string;
  isCaster: boolean;
  casterDisplayName: string | null;
}) {
  const router = useRouter();

  useRoomChannel(roomId, roundId, {
    "round-replay-changed": () => router.refresh(),
    "round-closed": () => router.refresh(),
    "round-cancelled": () => router.refresh(),
  });

  if (!isCaster) {
    const who = firstNameOrFallback(casterDisplayName, "the caster");
    return (
      <div className="w-full max-w-md rounded-lg border-2 border-gilt-dark bg-tavern-panel-dark p-4 text-center">
        <p className="font-body text-xs leading-relaxed text-parchment-dim">
          <span className="font-display uppercase tracking-widest text-gilt-bright">Time for Brew</span>
          {" — "}
          {who} is deciding whether to scrap this round and replay it. New rounds are on
          hold until they choose.
        </p>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Round replay"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-5"
    >
      <div className="w-full max-w-[340px] rounded-lg border-4 border-gilt bg-tavern-panel p-5 text-center shadow-[0_0_0_1px_theme(colors.gilt.dark),0_12px_32px_rgb(0_0_0_/_0.6)]">
        <h2 className="mb-1 font-display text-sm uppercase tracking-widest text-gilt-bright">
          Time for Brew
        </h2>
        <p className="mb-4 font-body text-xs leading-relaxed text-parchment-dim">
          The tea-maker has been announced. Scrap the result and replay the round entirely
          — new rolls, new cards may be played — or keep it as it stands.
        </p>
        <div className="flex flex-col gap-2">
          <form action={confirmRoundReplayAction}>
            <input type="hidden" name="roundId" value={roundId} />
            <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim">
              Replay the round
            </SubmitButton>
          </form>
          <form action={declineRoundReplayAction}>
            <input type="hidden" name="roundId" value={roundId} />
            <SubmitButton className="w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment-dim hover:text-parchment disabled:cursor-not-allowed">
              Keep the result
            </SubmitButton>
          </form>
        </div>
        <p className="mt-3 font-body text-[10px] leading-tight text-parchment-dim/70">
          If you don&rsquo;t choose within 5 minutes the result stands and the card is spent.
        </p>
      </div>
    </div>
  );
}
