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
import { castTargetMode } from "@/lib/game/castTargeting";
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

/**
 * The pre-roll cast form (issues #66/#67) — split out of SpellCardPanel so its
 * cast result can render inline, and its CHOSEN_PLAYERS picker can enforce a
 * minimum selection (issue #244).
 *
 * Target control per card is chosen by `castTargetMode` (issue #360): the
 * effect-application rebuild's by-name OPPONENT/PLAYER cards need an explicit
 * target at cast time (their `cast_spell_card` branch raises RFB46 with no
 * deferred path), so they render an at-cast picker here instead of the
 * "target chosen after declare-in" message — Stir the Pot gets its own
 * exactly-two-other-players picker, the rest a single-target select.
 */
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

  const mode = castTargetMode(held);
  const otherParticipants = participants.filter((p) => p.playerId !== selfPlayerId);

  // The checkbox picker is shared by the blanket CHOSEN_PLAYERS flow and Stir
  // the Pot's exactly-two-others flow; only the count rule and copy differ.
  const isTwoOthers = mode === "two-other-players";
  const isChosenPlayers = mode === "chosen-players";
  const belowMinimum = isChosenPlayers && chosenCount < MIN_CHOSEN_PLAYERS;
  const needsExactlyTwo = isTwoOthers && chosenCount !== 2;
  const disableSubmit = belowMinimum || needsExactlyTwo;

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="roundId" value={roundId} />
      {mode === "deferred-target" ? (
        <p className="mb-2 font-body text-xs text-parchment-dim">
          Target is chosen once declare-in closes and the roster is final.
        </p>
      ) : mode === "at-cast-target" ? (
        <label className="mb-2 block font-body text-xs text-parchment-dim">
          Choose a target:
          <select
            name="targetPlayerId"
            required
            defaultValue=""
            className="mt-1 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
          >
            <option value="" disabled>
              Select a player…
            </option>
            {otherParticipants.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.displayName ?? p.email}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-body text-xs text-parchment-dim">
            You name the target now, so you can only cast this once that player has declared in.
          </span>
        </label>
      ) : isChosenPlayers || isTwoOthers ? (
        <fieldset className="mb-2">
          <legend className="mb-1 font-body text-xs text-parchment-dim">
            {isTwoOthers ? "Choose exactly 2 other players:" : "Choose up to 3 players:"}
          </legend>
          <div className="flex flex-col gap-1">
            {otherParticipants.map((p) => (
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
          {needsExactlyTwo ? (
            <p className="mt-1 font-body text-xs text-parchment-dim">
              Choose exactly 2 other players ({chosenCount} selected).
            </p>
          ) : belowMinimum ? (
            <p className="mt-1 font-body text-xs text-parchment-dim">
              Choose at least {MIN_CHOSEN_PLAYERS} player{MIN_CHOSEN_PLAYERS === 1 ? "" : "s"}.
            </p>
          ) : null}
          {isTwoOthers ? (
            <p className="mt-1 font-body text-xs text-parchment-dim">
              You name both targets now, so you can only cast this once they have declared in.
            </p>
          ) : null}
        </fieldset>
      ) : mode === "declared-number" ? (
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
      <SubmitButton className={buttonClassName} disabled={disableSubmit}>
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
