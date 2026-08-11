"use client";

import { useActionState } from "react";
import {
  drawPendingSpellCardAction,
  drawPendingSpellCardManualAction,
  type DrawPendingSpellCardManualState,
} from "@/app/rounds/actions";
import { CardFrame } from "@/app/_components/CardFrame";
import { SubmitButton } from "@/app/_components/SubmitButton";

const initialState: DrawPendingSpellCardManualState = { status: "idle" };

/**
 * The "how did you draw?" prompt (issue: physical-deck draw override —
 * "players will definitely prefer drawing from the deck IRL") — shown once
 * the caller's earning round has resolved or been cancelled
 * (getMyPendingSpellDraw, the Spell Draw Window gate, issue #248),
 * regardless of whether that round is still activeRound. The trigger
 * itself is recorded immediately at roll time (maybeRecordPendingSpellDraw)
 * in place of the old immediate auto-draw; this panel only gates when the
 * choice is *offered*. Offers the same two paths dice rolling already
 * offers (#22): let the app generate the result, or trust a
 * physically-obtained one typed in by hand.
 *
 * Renders as a blocking modal (issue #268), matching TieRollModal's shell
 * (dimmed backdrop, centered card) rather than sitting inline in the page
 * flow — a pending draw is a genuinely blocking decision, not a passive
 * reference panel like BrewRatingPanel or RoundMenu. There is deliberately
 * no click-outside or Escape dismiss: the only way out is completing one of
 * the two forms below, same as the un-dismissable inline block this
 * replaces — the modal changes the container, not the escape hatches. The
 * kicker line above the title exists because this can appear well after
 * the triggering round has resolved (issue #248's gate), so the player
 * needs a reminder of why the prompt showed up now.
 */
export function SpellDrawChoicePanel({
  roundId,
  trigger,
  catalogNames,
  otherCount = 0,
}: {
  roundId: string;
  trigger: "nat1" | "nat20";
  catalogNames: string[];
  /** How many other eligible draws are queued behind this one (issue #248). */
  otherCount?: number;
}) {
  const [state, formAction, isPending] = useActionState(drawPendingSpellCardManualAction, initialState);

  return (
    <div
      role="dialog"
      aria-label="Draw a Spell Card"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-5"
    >
      <div className="w-full max-w-sm">
        <p className="mb-1 text-center font-body text-xs uppercase tracking-widest text-ember-bright">
          Roll settled — action needed
        </p>
        <CardFrame title="Draw a Spell Card">
          <p className="font-body text-sm text-parchment">
            You rolled a natural {trigger === "nat1" ? "1" : "20"} — draw a card.
          </p>
          {otherCount > 0 ? (
            <p className="mt-1 font-body text-xs text-parchment-dim">
              {otherCount} more waiting after this one.
            </p>
          ) : null}

          <form action={drawPendingSpellCardAction} className="mt-3">
            <input type="hidden" name="roundId" value={roundId} />
            <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
              Draw in the app
            </SubmitButton>
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
      </div>
    </div>
  );
}
