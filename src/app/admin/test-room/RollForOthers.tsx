import { submitManualRollAsAction, submitRollAsAction } from "@/app/admin/test-room/actions";
import { CardFrame } from "@/app/_components/CardFrame";
import type { InDeckSpellCard } from "@/lib/supabase/spellCards";

export type PendingRoller = {
  playerId: string;
  displayName: string | null;
  email: string;
};

export function RollForOthers({
  roundId,
  pendingRollers,
  inDeckCards,
}: {
  roundId: string;
  pendingRollers: PendingRoller[];
  inDeckCards: InDeckSpellCard[];
}) {
  if (pendingRollers.length === 0) return null;

  return (
    <CardFrame title="Roll For">
      <ul className="flex flex-col gap-3">
        {pendingRollers.map((player) => {
          const selectId = `forced-card-${player.playerId}`;
          return (
            <li key={player.playerId} className="flex flex-col gap-2">
              <form className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate font-body text-sm text-parchment">
                    {player.displayName ?? player.email}
                  </span>

                  <label htmlFor={selectId} className="sr-only">
                    Force crit card for {player.displayName ?? player.email}
                  </label>
                  <select
                    id={selectId}
                    name="forcedCardId"
                    defaultValue=""
                    className="max-w-[9rem] rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 font-body text-xs text-parchment focus:border-gilt focus:outline-none"
                  >
                    <option value="">Random on crit</option>
                    {inDeckCards.map((card) => (
                      <option key={card.cardId} value={card.cardId}>
                        {card.name} ({card.tier})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
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
                    formAction={submitManualRollAsAction}
                    className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:border-gilt"
                  >
                    Submit
                  </button>
                  <button
                    type="submit"
                    formAction={submitRollAsAction}
                    formNoValidate
                    className="rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
                  >
                    Roll
                  </button>
                </div>
              </form>
            </li>
          );
        })}
      </ul>
    </CardFrame>
  );
}
