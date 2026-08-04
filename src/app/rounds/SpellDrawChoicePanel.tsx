"use client";

import { useActionState } from "react";
import {
  drawPendingSpellCardAction,
  drawPendingSpellCardManualAction,
  type DrawPendingSpellCardManualState,
} from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";

const initialState: DrawPendingSpellCardManualState = { status: "idle" };

/**
 * The "how did you draw?" prompt (issue: physical-deck draw override —
 * "players will definitely prefer drawing from the deck IRL") — shown
 * whenever the caller has a pending spell draw for the active round
 * (getPendingSpellDraw, recorded by maybeRecordPendingSpellDraw in place of
 * the old immediate auto-draw). Offers the same two paths dice rolling
 * already offers (#22): let the app generate the result, or trust a
 * physically-obtained one typed in by hand.
 */
export function SpellDrawChoicePanel({
  roundId,
  trigger,
  catalogNames,
}: {
  roundId: string;
  trigger: "nat1" | "nat20";
  catalogNames: string[];
}) {
  const [state, formAction, isPending] = useActionState(drawPendingSpellCardManualAction, initialState);

  return (
    <section className="w-full max-w-sm">
      <CardFrame title="Draw a Spell Card">
        <p className="font-body text-sm text-parchment">
          You rolled a natural {trigger === "nat1" ? "1" : "20"} — draw a card.
        </p>

        <form action={drawPendingSpellCardAction} className="mt-3">
          <input type="hidden" name="roundId" value={roundId} />
          <button
            type="submit"
            className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright"
          >
            Draw in the app
          </button>
        </form>

        <div className="my-3 text-center font-body text-xs uppercase tracking-widest text-parchment-dim">or</div>

        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="roundId" value={roundId} />
          <label htmlFor="spell-draw-card-name" className="font-body text-xs text-parchment-dim">
            I drew this from the physical deck:
          </label>
          <input
            id="spell-draw-card-name"
            type="text"
            name="cardName"
            list="spell-card-catalog"
            required
            autoComplete="off"
            className="w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
          />
          <datalist id="spell-card-catalog">
            {catalogNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {state.status === "error" ? (
            <p role="alert" className="font-body text-xs text-red-500">
              {state.message}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-md border-2 border-gilt px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark disabled:cursor-not-allowed disabled:border-gilt-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
          >
            {isPending ? "Checking…" : "Confirm card"}
          </button>
        </form>
      </CardFrame>
    </section>
  );
}
