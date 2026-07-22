import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { updateRollInputModeAction } from "@/app/settings/actions";

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

export default async function SettingsPage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const rollInputMode = await getRollInputMode(supabase, current.playerId);

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="w-full max-w-sm">
        <h2 className="mb-2 text-lg font-medium">Roll input mode</h2>
        <form action={updateRollInputModeAction} className="flex flex-col gap-3">
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
          <button
            type="submit"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
          >
            Save
          </button>
        </form>
      </section>

      <Link href="/" className="text-sm underline">
        Back
      </Link>
    </main>
  );
}
