"use client";

import { useActionState, useState } from "react";
import { deleteAdjustmentAction, type DeleteAdjustmentState } from "./actions";
import type { AdminModifierAdjustmentListing } from "@/lib/supabase/modifierAdjustments";

const initialState: DeleteAdjustmentState = { status: "idle" };

/**
 * One row of the /admin/adjustments cleanup tool (issue #191). Same
 * collapsed-Delete-then-reveal-reason-and-Confirm shape as DeleteRoundRow
 * (src/app/admin/rounds/DeleteRoundRow.tsx) -- the reason isn't decorative
 * here either: admin_delete_modifier_adjustment (0056) logs it to
 * admin_modifier_adjustment_deletions before dropping the row, since that
 * row's own reason won't exist afterward to explain the delta.
 */
export function DeleteAdjustmentRow({ adjustment }: { adjustment: AdminModifierAdjustmentListing }) {
  const [state, formAction, isPending] = useActionState(deleteAdjustmentAction, initialState);
  const [confirming, setConfirming] = useState(false);

  return (
    <tr className="border-b border-gilt-dark/50 align-top">
      <td className="py-2 pr-3 font-body text-sm text-parchment-dim">{adjustment.roomDate}</td>
      <td className="py-2 pr-3 font-body text-sm text-parchment">
        {adjustment.targetDisplayName ?? adjustment.targetEmail}
      </td>
      <td className="py-2 pr-3 font-body text-sm text-parchment-dim">
        {adjustment.delta > 0 ? `+${adjustment.delta}` : adjustment.delta}
      </td>
      <td className="py-2 pr-3 font-body text-sm text-parchment-dim">{adjustment.reason}</td>
      <td className="py-2 pr-3 font-body text-sm text-parchment">
        {adjustment.actorDisplayName ?? adjustment.actorEmail}
      </td>
      <td className="py-2">
        {confirming ? (
          <form action={formAction} className="flex flex-col gap-1">
            <input type="hidden" name="adjustmentId" value={adjustment.id} />
            <input
              type="text"
              name="reason"
              required
              placeholder="Why is this adjustment being removed?"
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
