"use client";

import { useActionState, useState } from "react";
import { deleteRoundAction, type DeleteRoundState } from "./actions";
import type { AdminRoundListing } from "@/lib/supabase/adminRounds";

const initialState: DeleteRoundState = { status: "idle" };

const STATUS_LABEL: Record<AdminRoundListing["status"], string> = {
  open: "Open",
  closed: "Closed",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

/**
 * One row of the /admin/rounds cleanup tool (issue #189). Collapsed by
 * default to a single Delete button so the table stays scannable; clicking
 * it reveals a required reason field and an explicit Confirm — two motions,
 * not one click, since this is an irreversible hard delete. The reason isn't
 * decorative: admin_delete_round (0055) logs it to admin_round_deletions
 * before dropping the round row, since that row won't exist afterward to
 * attach the reason to.
 */
export function DeleteRoundRow({ round }: { round: AdminRoundListing }) {
  const [state, formAction, isPending] = useActionState(deleteRoundAction, initialState);
  const [confirming, setConfirming] = useState(false);

  return (
    <tr className="border-b border-gilt-dark/50 align-top">
      <td className="py-2 pr-3 font-body text-sm text-parchment">{round.roomDate}</td>
      <td className="py-2 pr-3 font-body text-sm text-parchment-dim">{STATUS_LABEL[round.status]}</td>
      <td className="py-2 pr-3 font-body text-sm text-parchment">
        {round.startedByDisplayName ?? round.startedByEmail}
      </td>
      <td className="py-2 pr-3 font-body text-sm text-parchment">
        {round.brewerDisplayName ?? round.brewerEmail ?? "—"}
        {round.cupsMade != null ? ` (${round.cupsMade} cups)` : ""}
      </td>
      <td className="py-2">
        {confirming ? (
          <form action={formAction} className="flex flex-col gap-1">
            <input type="hidden" name="roundId" value={round.id} />
            <input
              type="text"
              name="reason"
              required
              placeholder="Why is this round invalid?"
              className="rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-xs text-parchment focus:border-gilt focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded-md border-2 border-red-800 bg-red-900/60 px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment hover:bg-red-900 disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim"
              >
                {isPending ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
          >
            Delete
          </button>
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
