import type { OwnSpellCardState, SpellCardInfo } from "@/lib/supabase/spellCards";
import { resolveSpellCardSwapAction } from "@/app/rounds/actions";

const TIER_LABEL: Record<SpellCardInfo["tier"], string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

function CardFace({ card }: { card: SpellCardInfo }) {
  return (
    <div className="rounded border border-neutral-300 bg-white p-2">
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>{TIER_LABEL[card.tier]}</span>
        <span>{card.castingTime === "action" ? "Action" : "Reaction"}</span>
      </div>
      <p className="font-medium">{card.name}</p>
      <p className="text-sm text-neutral-600">{card.effectText}</p>
    </div>
  );
}

/**
 * The docked "held spell card" widget (issue #66, US3/US4): visible only on
 * the holder's own screen (their server-rendered props come from
 * get_own_spell_card_state, which only ever answers for the calling
 * player), showing at most the one card they currently hold. Never shows
 * deck contents or a remaining count (US9).
 *
 * When a draw while already holding a card leaves a keep-or-swap decision
 * pending (US6), the widget shows both cards side by side with a plain form
 * per choice — same "form posts to a server action" pattern as every other
 * round action (declareInAction, closeRoundAction, etc.), no client-side
 * state needed since resolving it just revalidates the page.
 */
export function HeldCardWidget({ state }: { state: OwnSpellCardState }) {
  if (state.pendingSwap) {
    const { drawId, newCard, currentCard } = state.pendingSwap;
    return (
      <div className="mt-3 rounded border border-indigo-300 bg-indigo-50 p-3 text-sm">
        <p className="mb-2 font-medium">You drew a new card — keep it, or keep the one you're holding?</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <CardFace card={currentCard} />
            <form action={resolveSpellCardSwapAction} className="mt-1">
              <input type="hidden" name="drawId" value={drawId} />
              <input type="hidden" name="keepNew" value="false" />
              <button
                type="submit"
                className="w-full rounded bg-neutral-900 px-2 py-1 text-xs text-white"
              >
                Keep this
              </button>
            </form>
          </div>
          <div>
            <CardFace card={newCard} />
            <form action={resolveSpellCardSwapAction} className="mt-1">
              <input type="hidden" name="drawId" value={drawId} />
              <input type="hidden" name="keepNew" value="true" />
              <button
                type="submit"
                className="w-full rounded bg-neutral-900 px-2 py-1 text-xs text-white"
              >
                Keep this
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (!state.held) return null;

  return (
    <div className="mt-3 max-w-[10rem]">
      <CardFace card={state.held} />
    </div>
  );
}
