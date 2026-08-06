"use client";

import { useActionState, useEffect, useRef } from "react";
import { logModifierAdjustmentAction, type LogModifierAdjustmentState } from "@/app/settings/actions";
import type { RosterEntry } from "@/lib/supabase/rooms";

const initialState: LogModifierAdjustmentState = { status: "idle" };

/**
 * Logs a Modifier Adjustment (issue #183): pick a target from today's
 * roster, a non-zero signed delta, and a required reason. Resets the delta
 * and reason fields after a successful submit so a second adjustment for a
 * different reason doesn't start pre-filled with the last one's text.
 */
export function ModifierAdjustmentForm({ roster }: { roster: RosterEntry[] }) {
  const [state, formAction, isPending] = useActionState(logModifierAdjustmentAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "idle") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-body text-sm text-parchment">
        Player
        <select
          name="targetPlayerId"
          required
          defaultValue=""
          className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
        >
          <option value="" disabled>
            Choose a player…
          </option>
          {roster.map((entry) => (
            <option key={entry.playerId} value={entry.playerId}>
              {entry.displayName ?? entry.email}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 font-body text-sm text-parchment">
        Delta
        <input
          type="number"
          name="delta"
          required
          step={1}
          placeholder="e.g. 2 or -1"
          className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1 font-body text-sm text-parchment">
        Reason
        <input
          type="text"
          name="reason"
          required
          placeholder="Why?"
          className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
      >
        {isPending ? "Logging…" : "Log Adjustment"}
      </button>

      {state.status === "error" ? (
        <p role="alert" className="font-body text-xs text-red-500">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
