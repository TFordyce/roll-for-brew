"use client";

import { useActionState, useEffect, useState } from "react";
import { updateRollInputModeAction, type UpdateRollInputModeState } from "@/app/settings/actions";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import { SelectableOption } from "@/app/_components/SelectableOption";

const ROLL_INPUT_MODE_OPTIONS = [
  {
    value: "in_app_only",
    label: "In-app only",
    description: "Every roll is generated in the app.",
  },
  {
    value: "manual_only",
    label: "Manual only",
    description: "Every roll is typed in by hand (1-20), trusted with no verification.",
  },
  {
    value: "both",
    label: "Both",
    description: "Choose in-app or manual fresh each time it's your turn to roll.",
  },
] as const;

const initialState: UpdateRollInputModeState = { status: "idle" };

export function SettingsForm({ rollInputMode }: { rollInputMode: RollInputMode }) {
  const [state, formAction, isPending] = useActionState(updateRollInputModeAction, initialState);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (state.status !== "saved") return;
    setShowSaved(true);
    const timer = setTimeout(() => setShowSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {ROLL_INPUT_MODE_OPTIONS.map((option) => (
        <SelectableOption
          key={option.value}
          name="rollInputMode"
          value={option.value}
          label={option.label}
          description={option.description}
          defaultChecked={rollInputMode === option.value}
        />
      ))}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {showSaved ? (
          <span role="status" className="font-display text-sm uppercase tracking-wide text-gilt-bright">
            Saved
          </span>
        ) : null}
      </div>
    </form>
  );
}
