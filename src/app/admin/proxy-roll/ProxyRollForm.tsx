"use client";

import { useActionState } from "react";
import { adminProxyRollAction, type AdminProxyRollState } from "./actions";
import type { RealPlayer } from "@/lib/supabase/players";

const initialState: AdminProxyRollState = { status: "idle" };

/**
 * The /admin/proxy-roll form itself (issue #273): picks one of today's
 * absent real players and the value they read out loud, then submits
 * adminProxyRollAction. Only rendered by the page when it's already
 * confirmed the round is eligible and there's at least one absent player to
 * pick from.
 */
export function ProxyRollForm({ roundId, absentPlayers }: { roundId: string; absentPlayers: RealPlayer[] }) {
  const [state, formAction, isPending] = useActionState(adminProxyRollAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="roundId" value={roundId} />

      <label className="flex flex-col gap-1">
        <span className="font-display text-[10px] uppercase tracking-widest text-parchment-dim">Player</span>
        <select
          name="playerId"
          required
          className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
        >
          {absentPlayers.map((player) => (
            <option key={player.id} value={player.id}>
              {player.displayName ?? player.email}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-display text-[10px] uppercase tracking-widest text-parchment-dim">
          Value they rolled (1-20)
        </span>
        <input
          type="number"
          name="value"
          min={1}
          max={20}
          required
          className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1.5 text-sm text-parchment focus:border-gilt focus:outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border-2 border-gilt bg-ember px-3 py-2 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim"
      >
        {isPending ? "Submitting…" : "Submit proxy roll"}
      </button>

      {state.status === "error" ? (
        <p role="alert" className="font-body text-xs text-red-500">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
