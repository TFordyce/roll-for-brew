"use client";

import { useState } from "react";
import { InAppRollForm, ManualRollForm } from "@/app/rounds/RollForms";

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
