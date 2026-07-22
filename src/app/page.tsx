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
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { getMySpellCards } from "@/lib/supabase/spellCards";
import { getMyPendingCasts } from "@/lib/supabase/spellCasts";
import { Nav } from "@/app/Nav";

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

  const heldSpellCards = await getMySpellCards(supabase);
  const pendingSpellCasts =
    activeRound && activeRound.status === "closed"
      ? await getMyPendingCasts(supabase, activeRound.id)
      : [];

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

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
      />

      {activeRound ? (
        <section className="w-full max-w-sm">
          <h2 className="mb-2 text-lg font-medium">
            {activeRound.status === "open" ? "Round open — declared in" : "Declarations closed"}
          </h2>
          {activeRound.status === "closed" && isTiePhase ? (
            <TieBanner
              key={currentLayer}
              roomId={roomId}
              roundId={activeRound.id}
              selfPlayerId={playerId}
              ownRoll={ownRoll}
              tiedParticipants={tiedParticipants}
              rollInputMode={rollInputMode}
            />
          ) : activeRound.status === "closed" ? (
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
            <>
              <RoundOpenLive roomId={roomId} roundId={activeRound.id} />
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
            </>
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

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
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
