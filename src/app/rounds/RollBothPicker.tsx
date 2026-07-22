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
          className="flex-1 rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
        >
          Roll in-app
        </button>
        <button
          type="button"
          onClick={() => setChoice("manual")}
          className="flex-1 rounded-md border-2 border-gilt px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-tavern-panel-dark"
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
