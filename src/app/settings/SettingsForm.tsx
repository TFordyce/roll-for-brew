"use client";

import { useActionState, useEffect, useState } from "react";
import { updateRollInputModeAction, type UpdateRollInputModeState } from "@/app/settings/actions";
import type { RollInputMode } from "@/lib/supabase/playerSettings";

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
        <label
          key={option.value}
          className="flex items-start gap-3 rounded border border-neutral-200 px-3 py-2 text-sm"
        >
          <input
            type="radio"
            name="rollInputMode"
            value={option.value}
            defaultChecked={rollInputMode === option.value}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">{option.label}</span>
            <span className="block text-neutral-500">{option.description}</span>
          </span>
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {showSaved ? (
          <span role="status" className="text-sm text-emerald-600">
            Saved
          </span>
        ) : null}
      </div>
    </form>
  );
}
