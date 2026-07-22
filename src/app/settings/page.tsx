import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { SettingsForm } from "@/app/settings/SettingsForm";

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
        <SettingsForm rollInputMode={rollInputMode} />
      </section>

      <Link href="/" className="text-sm underline">
        Back
      </Link>
    </main>
  );
}
