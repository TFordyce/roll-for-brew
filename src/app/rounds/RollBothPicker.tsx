"use client";

import { useState } from "react";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";

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

  return choice === "in_app" ? (
    <InAppRollForm roundId={roundId} />
  ) : (
    <ManualRollForm roundId={roundId} />
  );
}
