"use client";

import { deleteModifierAdjustmentAction } from "@/app/settings/actions";
import type { ModifierAdjustment } from "@/lib/supabase/modifierAdjustments";

const UNDO_WINDOW_MS = 5 * 60 * 1000;

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function formatTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Today's logged Modifier Adjustments (issue #183), newest first. The undo
 * button is shown only on the caller's own most-recent entry -- the first
 * row in this (already newest-first) list whose actor is the caller -- and
 * only while it's still within the 5 minute window
 * delete_modifier_adjustment (0052) itself enforces. That's a rendering
 * convenience, not the source of truth: the RPC re-checks both conditions
 * server-side regardless of what this component decides to show.
 */
export function ModifierAdjustmentList({
  adjustments,
  currentPlayerId,
}: {
  adjustments: ModifierAdjustment[];
  currentPlayerId: string;
}) {
  const mostRecentOwnId = adjustments.find((a) => a.actorPlayerId === currentPlayerId)?.id;
  const now = Date.now();

  if (adjustments.length === 0) {
    return <p className="font-body text-sm text-parchment-dim">No adjustments logged today.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {adjustments.map((adjustment) => {
        const canUndo =
          adjustment.id === mostRecentOwnId && now - new Date(adjustment.createdAt).getTime() < UNDO_WINDOW_MS;

        return (
          <li
            key={adjustment.id}
            className="flex items-start justify-between gap-3 border-b border-gilt-dark/50 pb-2 font-body text-sm text-parchment"
          >
            <div>
              <p>
                <span className="font-display text-xs uppercase tracking-widest text-gilt-bright">
                  {formatDelta(adjustment.delta)}
                </span>{" "}
                to {adjustment.targetDisplayName ?? adjustment.targetEmail}
              </p>
              <p className="text-xs text-parchment-dim">
                {adjustment.reason} — by {adjustment.actorDisplayName ?? adjustment.actorEmail} at{" "}
                {formatTime(adjustment.createdAt)}
              </p>
            </div>

            {canUndo ? (
              <form action={deleteModifierAdjustmentAction}>
                <input type="hidden" name="adjustmentId" value={adjustment.id} />
                <button
                  type="submit"
                  className="shrink-0 rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
                >
                  Undo
                </button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
