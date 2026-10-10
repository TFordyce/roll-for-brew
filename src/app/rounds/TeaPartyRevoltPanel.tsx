"use client";

import { useActionState } from "react";
import { setTeaPartyRevoltTargetAction } from "@/app/rounds/actions";
import type { SpellCastActionState } from "@/app/rounds/roundActionHelpers";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import { CardFrame } from "@/app/_components/CardFrame";
import { SubmitButton } from "@/app/_components/SubmitButton";

const initialState: SpellCastActionState = { status: "idle" };

export function TeaPartyRevoltPanel({
  roundId,
  pickerId,
  pickerName,
  selfPlayerId,
  participants,
}: {
  roundId: string;
  pickerId: string;
  pickerName: string;
  selfPlayerId: string;
  participants: RoundParticipant[];
}) {
  const [state, formAction] = useActionState(setTeaPartyRevoltTargetAction, initialState);
  const options = participants.filter((p) => p.excludedAt === null);

  return (
    <section className="w-full max-w-sm">
      <CardFrame title="Tea Party Revolt!">
        {pickerId === selfPlayerId ? (
          <form action={formAction}>
            <input type="hidden" name="roundId" value={roundId} />
            <p className="mb-2 font-body text-sm text-parchment">
              You rolled lowest. <strong className="text-gilt-bright">Choose who makes tea</strong> this round:
            </p>
            <select
              name="targetPlayerId"
              required
              className="mb-2 w-full rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
            >
              {options.map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.playerId === selfPlayerId ? "Me" : (p.displayName ?? p.email)}
                </option>
              ))}
            </select>
            {state.status === "error" ? (
              <p role="alert" className="mb-2 font-body text-xs text-red-500">
                {state.message}
              </p>
            ) : null}
            <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-3 py-1.5 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
              Choose
            </SubmitButton>
          </form>
        ) : (
          <p className="font-body text-sm text-parchment-dim">
            {pickerName} rolled lowest and is choosing who makes tea.
          </p>
        )}
      </CardFrame>
    </section>
  );
}
