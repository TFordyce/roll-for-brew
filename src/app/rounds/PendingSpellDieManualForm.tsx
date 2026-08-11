"use client";

import { useActionState } from "react";
import { resolvePendingSpellDieManualAction } from "@/app/rounds/actions";
import { SubmitButton } from "@/app/_components/SubmitButton";
import type { SpellCastActionState } from "@/app/rounds/roundActionHelpers";

const initialState: SpellCastActionState = { status: "idle" };

/**
 * Client half of ManualSpellDieForm (SpellDieForms.tsx) — resolving a
 * Pending Spell Die's manual entry (issue #252) needs useActionState for
 * its inline typed error (a value outside the card's dice range), the same
 * reason SpellDrawChoicePanel's own manual-entry form is a client component.
 */
export function PendingSpellDieManualForm({
  roundId,
  castId,
  min,
  max,
}: {
  roundId: string;
  castId: string;
  min: number;
  max: number;
}) {
  const [state, formAction] = useActionState(resolvePendingSpellDieManualAction, initialState);

  return (
    <form action={formAction} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="roundId" value={roundId} />
      <input type="hidden" name="castId" value={castId} />
      <div className="flex items-center gap-2">
        <input
          type="number"
          name="value"
          min={min}
          max={max}
          required
          className="w-16 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 font-mono text-sm text-parchment focus:border-gilt focus:outline-none"
        />
        <SubmitButton className="flex-1 rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
          Submit
        </SubmitButton>
      </div>
      {state.status === "error" ? (
        <p role="alert" className="font-body text-xs text-red-500">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
