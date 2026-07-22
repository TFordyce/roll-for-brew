import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { googlePlayerId } from "@/lib/supabase/players";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";
import { getActiveRound, getRoundParticipants } from "@/lib/supabase/rounds";
import { getOwnRoll } from "@/lib/supabase/rolls";
import {
  closeRoundAction,
  declareInAction,
  startRoundAction,
  submitRollAction,
} from "@/app/rounds/actions";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { Nav } from "@/app/Nav";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const playerId = googlePlayerId(user);

  const { data: player } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", playerId)
    .maybeSingle();

  const roomId = await enterTodaysRoom(supabase);
  const roster = await getRoomRoster(supabase, roomId);

  const activeRound = await getActiveRound(supabase, roomId);
  const participants = activeRound ? await getRoundParticipants(supabase, activeRound.id) : [];
  const hasDeclared = participants.some((p) => p.playerId === playerId);
  const isStarter = activeRound?.startedBy === playerId;
  const canClose = activeRound?.status === "open" && isStarter && participants.length >= 2;

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const ownRoll =
    activeRound?.status === "closed" && hasDeclared
      ? await getOwnRoll(supabase, activeRound.id, playerId)
      : null;

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Roll for Brew</h1>
      <Nav active="room" />
      <p className="text-sm text-neutral-500">
        Signed in as {player?.display_name ?? player?.email ?? user.email}
      </p>

      {activeRound ? (
        <section className="w-full max-w-sm">
          <h2 className="mb-2 text-lg font-medium">
            {activeRound.status === "open" ? "Round open — declared in" : "Declarations closed"}
          </h2>
          {activeRound.status === "closed" ? (
            <RoundReveal
              roomId={roomId}
              roundId={activeRound.id}
              selfPlayerId={playerId}
              ownRoll={ownRoll}
              participants={participants.map((entry) => ({
                playerId: entry.playerId,
                displayName: entry.displayName,
                email: entry.email,
                modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
              }))}
            />
          ) : (
            <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
              {participants.map((entry) => (
                <li
                  key={entry.playerId}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span>
                    {entry.displayName ?? entry.email}
                    {entry.playerId === activeRound.startedBy ? " (starter)" : ""}
                  </span>
                  <span className="font-mono">
                    {modifierByPlayerId.get(entry.playerId) ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {activeRound.status === "open" && !hasDeclared ? (
            <form action={declareInAction} className="mt-3">
              <input type="hidden" name="roundId" value={activeRound.id} />
              <button
                type="submit"
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
              >
                I&rsquo;m in
              </button>
            </form>
          ) : null}

          {isStarter && activeRound.status === "open" ? (
            <form action={closeRoundAction} className="mt-3">
              <input type="hidden" name="roundId" value={activeRound.id} />
              <button
                type="submit"
                disabled={!canClose}
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Close declarations{canClose ? "" : ` (need ${2 - participants.length} more)`}
              </button>
            </form>
          ) : null}

          {activeRound.status === "closed" && hasDeclared && ownRoll === null ? (
            <form action={submitRollAction} className="mt-3">
              <input type="hidden" name="roundId" value={activeRound.id} />
              <button
                type="submit"
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
              >
                Roll
              </button>
            </form>
          ) : null}
        </section>
      ) : (
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

          <form action={startRoundAction} className="mt-3">
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            >
              Start round
            </button>
          </form>
        </section>
      )}

      <form action="/auth/signout" method="post">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
