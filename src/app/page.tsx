import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: player } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", googlePlayerId(user))
    .maybeSingle();

  const roomId = await enterTodaysRoom(supabase);
  const roster = await getRoomRoster(supabase, roomId);

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Roll for Brew</h1>
      <p className="text-sm text-neutral-500">
        Signed in as {player?.display_name ?? player?.email ?? user.email}
      </p>

      <section className="w-full max-w-sm">
        <h2 className="mb-2 text-lg font-medium">Room</h2>
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {roster.map((entry) => (
            <li
              key={entry.playerId}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span>{entry.displayName ?? entry.email}</span>
              <span className="font-mono">{entry.modifier}</span>
            </li>
          ))}
        </ul>
      </section>

      <form action="/auth/signout" method="post">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
