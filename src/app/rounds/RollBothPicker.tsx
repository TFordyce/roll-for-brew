"use client";

import { useState } from "react";
import { submitManualRollAction, submitRollAction } from "@/app/rounds/actions";

/**
 * The roll_input_mode = 'both' experience (issue #22): no locked-in mode, so
 * every time it's this player's turn to roll they get a fresh in-app/manual
 * picker. Local-only state — nothing here is persisted, since the "both"
 * preference means the choice is made anew per roll, not remembered.
 */
export function RollBothPicker({ roundId }: { roundId: string }) {
  const [choice, setChoice] = useState<"unset" | "in_app" | "manual">("unset");

  if (choice === "unset") {
    return (
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setChoice("in_app")}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
        >
          Roll in-app
        </button>
        <button
          type="button"
          onClick={() => setChoice("manual")}
          className="rounded border border-neutral-900 px-3 py-1.5 text-sm text-neutral-900"
        >
          Enter manually
        </button>
      </div>
    );
  }

  if (choice === "in_app") {
    return (
      <form action={submitRollAction} className="mt-3">
        <input type="hidden" name="roundId" value={roundId} />
        <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
          Roll
        </button>
      </form>
    );
  }

  return (
    <form action={submitManualRollAction} className="mt-3 flex items-center gap-2">
      <input type="hidden" name="roundId" value={roundId} />
      <input
        type="number"
        name="value"
        min={1}
        max={20}
        required
        className="w-16 rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
        Submit
      </button>
    </form>
  );
}
