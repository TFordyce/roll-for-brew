import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer } from "@/lib/supabase/players";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";
import { getActiveRound, getRoundLayerParticipants, getRoundParticipants } from "@/lib/supabase/rounds";
import { getOwnRoll } from "@/lib/supabase/rolls";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { isExpectedLayerRoller } from "@/lib/supabase/stall";
import { closeRoundAction, declareInAction, startRoundAction } from "@/app/rounds/actions";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";
import { RoundOpenLive } from "@/app/rounds/RoundOpenLive";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { TieBanner } from "@/app/rounds/TieBanner";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";

export default async function HomePage() {
  const supabase = await createClient();
  const current = await getCurrentPlayer(supabase);

  if (!current) {
    redirect("/login");
  }

  const { playerId, user } = current;

  const { data: player } = await supabase
    .from("players")
    .select("display_name, email, avatar_url")
    .eq("id", playerId)
    .maybeSingle();

  const roomId = await enterTodaysRoom(supabase);
  const roster = await getRoomRoster(supabase, roomId);

  let activeRound = await getActiveRound(supabase, roomId);
  if (activeRound) {
    const stallOutcome = await enforceStallTimeout(supabase, activeRound.id);
    if (stallOutcome.action !== "none") {
      activeRound = await getActiveRound(supabase, roomId);
    }
  }
  const participants = activeRound ? await getRoundParticipants(supabase, activeRound.id) : [];
  const hasDeclared = participants.some((p) => p.playerId === playerId);
  const isStarter = activeRound?.startedBy === playerId;
  const canClose = activeRound?.status === "open" && isStarter && participants.length >= 2;

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const currentLayer = activeRound?.currentLayer ?? 0;
  const isTiePhase = activeRound?.status === "closed" && currentLayer > 0;
  const tiedParticipants =
    activeRound && isTiePhase
      ? await getRoundLayerParticipants(supabase, activeRound.id, currentLayer)
      : [];
  const isTied = tiedParticipants.some((p) => p.playerId === playerId);

  const ownRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

  // Whether it's this player's turn to submit a roll right now: they're
  // expected to roll the round's current layer (is_expected_layer_roller,
  // issue #40 — the same SQL predicate submit_roll/submit_manual_roll gate
  // on, so this reads its answer rather than re-deriving hasDeclared/isTied/
  // excludedAt locally) and haven't already rolled it. The player's
  // roll_input_mode preference (#22) then decides which input method(s)
  // they're offered.
  const isExpectedToRoll =
    activeRound?.status === "closed"
      ? await isExpectedLayerRoller(supabase, activeRound.id, playerId, currentLayer)
      : false;
  const isPlayersTurnToRoll = isExpectedToRoll && ownRoll === null;
  const rollInputMode = isPlayersTurnToRoll ? await getRollInputMode(supabase, playerId) : null;
  const needsRollInput = isPlayersTurnToRoll && !isTiePhase;

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Roll for Brew</h1>
      <Nav active="room" />
      <p className="text-sm text-neutral-500">
        Signed in as {player?.display_name ?? player?.email ?? user.email}
      </p>

      {activeRound ? (
        <section className="w-full max-w-sm">
          {activeRound.status === "closed" && isTiePhase ? (
            <>
              <h2 className="mb-2 text-lg font-medium">Rolling</h2>
              <TieBanner
                key={currentLayer}
                roomId={roomId}
                roundId={activeRound.id}
                selfPlayerId={playerId}
                ownRoll={ownRoll}
                tiedParticipants={tiedParticipants}
                rollInputMode={rollInputMode}
              />
            </>
          ) : activeRound.status === "closed" ? (
            <>
              <h2 className="mb-2 text-lg font-medium">Rolling</h2>
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
            </>
          ) : (
            <div className="rounded-lg bg-wood-planks p-4">
              <RoundOpenLive roomId={roomId} roundId={activeRound.id} />
              <CardFrame title="Who's In?">
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {roster.map((entry) => (
                    <PlayerTile
                      key={entry.playerId}
                      displayName={entry.displayName}
                      email={entry.email}
                      avatarUrl={entry.avatarUrl}
                      modifier={entry.modifier}
                      joined={participants.some((p) => p.playerId === entry.playerId)}
                      isStarter={entry.playerId === activeRound.startedBy}
                    />
                  ))}
                </div>

                {!hasDeclared ? (
                  <form action={declareInAction} className="mt-4">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <button
                      type="submit"
                      className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
                    >
                      I&rsquo;m in
                    </button>
                  </form>
                ) : null}

                {isStarter ? (
                  <form action={closeRoundAction} className="mt-3">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <button
                      type="submit"
                      disabled={!canClose}
                      className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
                    >
                      {canClose ? "Let's roll" : `Need ${2 - participants.length} more to roll`}
                    </button>
                  </form>
                ) : null}
              </CardFrame>
            </div>
          )}

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
          ) : null}
        </section>
      ) : (
        <section className="w-full max-w-sm">
          <div className="rounded-lg bg-wood-planks p-4">
            <CardFrame title="The Room">
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {roster.map((entry) => (
                  <PlayerTile
                    key={entry.playerId}
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    modifier={entry.modifier}
                  />
                ))}
              </div>

              <form action={startRoundAction} className="mt-4">
                <button
                  type="submit"
                  className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
                >
                  Start Round
                </button>
              </form>
            </CardFrame>
          </div>
        </section>
      )}

      <Link href="/settings" className="text-sm underline">
        Settings
      </Link>

      <form action="/auth/signout" method="post">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
