"use client";

import { useActionState } from "react";
import { allocateSpellCardAction, unassignSpellCardAction, type AllocateSpellCardState } from "./actions";
import type { CardAssignment } from "@/lib/supabase/adminCards";
import type { RealPlayer } from "@/lib/supabase/players";

const initialState: AllocateSpellCardState = { status: "idle" };

const TIER_LABEL: Record<CardAssignment["tier"], string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

/**
 * One row of the /admin/cards bulk table (issue #154): the card's current
 * holder (or an inline player-picker to assign one) plus an Unassign button
 * once it's held. A held/pending_swap card only ever shows Unassign — never
 * a picker to reassign straight to someone else — so a conflict always
 * requires the admin to explicitly clear the old hold first, matching
 * admin_allocate_spell_card's own RFB07/RFB08 refusal to auto-reassign.
 */
export function CardAssignmentRow({ card, players }: { card: CardAssignment; players: RealPlayer[] }) {
  const [state, formAction, isPending] = useActionState(allocateSpellCardAction, initialState);
  const isAssigned = card.location !== "in_deck";

  return (
    <tr className="border-b border-gilt-dark/50 align-top">
      <td className="py-2 pr-3 font-body text-sm text-parchment">
        {card.name}
        <span className="ml-2 font-display text-[10px] uppercase tracking-widest text-parchment-dim">
          {TIER_LABEL[card.tier]}
        </span>
      </td>

      <td className="py-2 pr-3 font-body text-sm">
        {isAssigned ? (
          <div className="flex flex-col">
            <span className="text-parchment">{card.heldByDisplayName ?? card.heldByEmail ?? card.heldByPlayerId}</span>
            {card.location === "pending_swap" ? (
              <span className="font-display text-[10px] uppercase tracking-widest text-parchment-dim">
                Pending swap decision
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-parchment-dim">Unassigned</span>
        )}
      </td>

      <td className="py-2">
        {isAssigned ? (
          <form action={unassignSpellCardAction}>
            <input type="hidden" name="cardId" value={card.cardId} />
            <button
              type="submit"
              className="rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
            >
              Unassign
            </button>
          </form>
        ) : (
          <form action={formAction} className="flex flex-col gap-1 sm:flex-row sm:items-center">
            <input type="hidden" name="cardId" value={card.cardId} />
            <select
              name="playerId"
              required
              defaultValue=""
              className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-xs text-parchment focus:border-gilt focus:outline-none"
            >
              <option value="" disabled>
                Choose a player…
              </option>
              {players.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.displayName ?? player.email}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md border-2 border-gilt bg-ember px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim"
            >
              {isPending ? "Assigning…" : "Assign"}
            </button>
          </form>
        )}
        {state.status === "error" ? (
          <p role="alert" className="mt-1 font-body text-xs text-red-500">
            {state.message}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
