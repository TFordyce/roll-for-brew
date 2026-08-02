import { submitManualRollAsAction, submitRollAsAction } from "@/app/admin/test-room/actions";
import { CardFrame } from "@/app/_components/CardFrame";

export type PendingRoller = {
  playerId: string;
  displayName: string | null;
  email: string;
};

/**
 * Admin-only "roll for others" panel (issue #102 follow-up): lists every
 * Test Room player still expected to roll the round's current layer, each
 * with its own manual-value field and random-roll button — so an admin can
 * fill in or roll the whole table's dice without switching Acting As once
 * per person. Both forms post straight to submit_roll_as/submit_manual_roll_as
 * (via the actions below), which re-check admin + Test Room status
 * server-side regardless of what this panel renders.
 */
export function RollForOthers({
  roundId,
  pendingRollers,
}: {
  roundId: string;
  pendingRollers: PendingRoller[];
}) {
  if (pendingRollers.length === 0) return null;

  return (
    <CardFrame title="Roll For">
      <ul className="flex flex-col gap-3">
        {pendingRollers.map((player) => (
          <li key={player.playerId} className="flex items-center gap-2">
            <span className="flex-1 truncate font-body text-sm text-parchment">
              {player.displayName ?? player.email}
            </span>

            <form action={submitManualRollAsAction} className="flex items-center gap-2">
              <input type="hidden" name="roundId" value={roundId} />
              <input type="hidden" name="playerId" value={player.playerId} />
              <input
                type="number"
                name="value"
                min={1}
                max={20}
                required
                className="w-14 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 font-mono text-sm text-parchment focus:border-gilt focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:border-gilt"
              >
                Submit
              </button>
            </form>

            <form action={submitRollAsAction}>
              <input type="hidden" name="roundId" value={roundId} />
              <input type="hidden" name="playerId" value={player.playerId} />
              <button
                type="submit"
                className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
              >
                Roll
              </button>
            </form>
          </li>
        ))}
      </ul>
    </CardFrame>
  );
}
