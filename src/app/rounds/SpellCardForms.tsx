"use client";

import { useActionState, useState } from "react";
import {
  castSpellCardAction,
  endActiveEffectAction,
  setSpellCastTargetAction,
} from "@/app/rounds/actions";
import type { SpellCastActionState } from "@/app/rounds/roundActionHelpers";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { DispellableEffect, PendingCast } from "@/lib/supabase/spellCasts";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { SubmitButton } from "@/app/_components/SubmitButton";

const initialState: SpellCastActionState = { status: "idle" };

/**
 * A card's own minimum for CHOSEN_PLAYERS is not currently plumbed through
 * to the client (spell_card_effects.effect_params only carries a
 * max_targets ceiling — see issue #244's research) — the server's own
 * blanket floor (cast_spell_card: "this card requires at least one chosen
 * player") is 1, so that's what the client guard mirrors.
 */
const MIN_CHOSEN_PLAYERS = 1;

/** Renders a SpellCastActionState's error inline, near the form's own submit button (issue #244). */
function CastErrorMessage({ state }: { state: SpellCastActionState }) {
  if (state.status !== "error") return null;
  return (
    <p role="alert" className="mb-2 font-body text-xs text-red-500">
      {state.message}
    </p>
  );
}

const buttonClassName =
  "w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark";

/** The dispel (Lesser Detox, issue #69) form — split out of SpellCardPanel so its cast result can render inline (issue #244). */
export function DispelForm({
  roundId,
  cardName,
  dispellableEffects,
}: {
  roundId: string;
  cardName: string;
  dispellableEffects: DispellableEffect[];
}) {
  const [state, formAction] = useActionState(endActiveEffectAction, initialState);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      <select
        name="effectId"
        required
        className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
      >
        {dispellableEffects.map((effect) => (
          <option key={effect.effectId} value={effect.effectId}>
            {effect.cardName} on {effect.targetDisplayName} ({effect.tier})
          </option>
        ))}
      </select>
      <CastErrorMessage state={state} />
      <SubmitButton className={buttonClassName}>End effect with {cardName}</SubmitButton>
    </form>
  );
}

/** The pre-roll cast form (issues #66/#67) — split out of SpellCardPanel so its cast result can render inline, and its CHOSEN_PLAYERS picker can enforce a minimum selection (issue #244). */
export function CastForm({
  roundId,
  held,
  participants,
  selfPlayerId,
}: {
  roundId: string;
  held: HeldSpellCard;
  participants: RoundParticipant[];
  selfPlayerId: string;
}) {
  const [state, formAction] = useActionState(castSpellCardAction, initialState);
  const [chosenCount, setChosenCount] = useState(0);

  const isChosenPlayers = held.target === "CHOSEN_PLAYERS";
  const belowMinimum = isChosenPlayers && chosenCount < MIN_CHOSEN_PLAYERS;

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      {held.target === "OPPONENT" || held.target === "PLAYER" ? (
        <p className="mb-2 font-body text-xs text-parchment-dim">
          Target is chosen once declare-in closes and the roster is final.
        </p>
      ) : isChosenPlayers ? (
        <fieldset className="mb-2">
          <legend className="mb-1 font-body text-xs text-parchment-dim">Choose up to 3 players:</legend>
          <div className="flex flex-col gap-1">
            {participants
              .filter((p) => p.playerId !== selfPlayerId)
              .map((p) => (
                <label key={p.playerId} className="flex items-center gap-2 font-body text-sm text-parchment">
                  <input
                    type="checkbox"
                    name="chosenPlayerIds"
                    value={p.playerId}
                    onChange={(e) => setChosenCount((count) => count + (e.target.checked ? 1 : -1))}
                  />
                  {p.displayName ?? p.email}
                </label>
              ))}
          </div>
          {belowMinimum ? (
            <p className="mt-1 font-body text-xs text-parchment-dim">
              Choose at least {MIN_CHOSEN_PLAYERS} player{MIN_CHOSEN_PLAYERS === 1 ? "" : "s"}.
            </p>
          ) : null}
        </fieldset>
      ) : held.effectKind === "declared_number_tea_maker" ? (
        <label className="mb-2 block font-body text-xs text-parchment-dim">
          Declare a number (1–20):
          <input
            type="number"
            name="declaredNumber"
            min={1}
            max={20}
            required
            className="mt-1 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
          />
        </label>
      ) : null}
      <CastErrorMessage state={state} />
      <SubmitButton className={buttonClassName} disabled={belowMinimum}>
        Cast {held.cardName}
      </SubmitButton>
    </form>
  );
}

/** One target-confirmation form per pending (declare-in-deferred) cast (issue #67) — split out of SpellCardPanel so each cast's result renders inline against its own form (issue #244). */
export function TargetConfirmForm({
  roundId,
  cast,
  options,
}: {
  roundId: string;
  cast: PendingCast;
  options: RoundParticipant[];
}) {
  const [state, formAction] = useActionState(setSpellCastTargetAction, initialState);

  return (
    <form action={formAction} className="mt-3 first:mt-0">
      <input type="hidden" name="castId" value={cast.castId} />
      <input type="hidden" name="roundId" value={roundId} />
      <p className="mb-1 font-body text-sm text-parchment">
        Choose a target for <strong className="text-gilt-bright">{cast.cardName}</strong>:
      </p>
      <select
        name="targetPlayerId"
        required
        className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
      >
        {options.map((p) => (
          <option key={p.playerId} value={p.playerId}>
            {p.displayName ?? p.email}
          </option>
        ))}
      </select>
      <CastErrorMessage state={state} />
      <SubmitButton className={buttonClassName}>Confirm target</SubmitButton>
    </form>
  );
}
