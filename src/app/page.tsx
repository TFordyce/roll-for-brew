import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPlayer, getIsAdmin } from "@/lib/supabase/players";
import { getAdminModeEnabled } from "@/lib/supabase/adminMode";
import { canAccessTestRoom } from "@/lib/game/testRoomAccess";
import { enterTodaysRoom, getRoomRoster } from "@/lib/supabase/rooms";
import {
  getActiveRound,
  getRoundLayerParticipants,
  getRoundParticipants,
  roundHasAnyRolls,
} from "@/lib/supabase/rounds";
import { getOwnRoll } from "@/lib/supabase/rolls";
import { getRollInputMode } from "@/lib/supabase/playerSettings";
import { getMyMostRecentOrder, getMyOrderableRound, getMyOrderForRound } from "@/lib/supabase/orders";
import { getRoundMenu } from "@/lib/supabase/menu";
import { isExpectedLayerRoller } from "@/lib/supabase/stall";
import {
  closeRoundAction,
  declareInAction,
  declareInLateAction,
  startRoundAction,
  withdrawDeclarationAction,
} from "@/app/rounds/actions";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";
import { RoomIdleLive } from "@/app/rounds/RoomIdleLive";
import { RoundOpenLive } from "@/app/rounds/RoundOpenLive";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { OrderPicker } from "@/app/rounds/OrderPicker";
import { RoundMenu } from "@/app/rounds/RoundMenu";
import { MenuLive } from "@/app/rounds/MenuLive";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { SpellCastLive } from "@/app/rounds/SpellCastLive";
import { SpellDrawChoicePanel } from "@/app/rounds/SpellDrawChoicePanel";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { getMyPendingSpellDraw, getMySpellCards, getSpellCardCatalog } from "@/lib/supabase/spellCards";
import {
  type ActiveEffectBadge,
  getDispellableActiveEffects,
  getMyPendingCasts,
  getRoomActiveEffects,
} from "@/lib/supabase/spellCasts";
import { getOpenReactionWindow, getReactionStack, getReactionWindowPendingPlayers } from "@/lib/supabase/reactionWindow";
import { getMyRateableRound } from "@/lib/supabase/brewRatings";
import { initialsFrom } from "@/lib/game/initials";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { SignOutBadge } from "@/app/_components/SignOutBadge";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { BrewRatingPanel } from "@/app/_components/BrewRatingPanel";

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

  const isAdmin = await getIsAdmin(supabase, playerId);
  const adminModeEnabled = isAdmin ? await getAdminModeEnabled() : false;
  const showAdminMenu = canAccessTestRoom({ isAdmin, adminModeEnabled });

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

  // Late Declare (issue #246): "Add me in!" only ever needs to render for a
  // closed round the caller hasn't already joined — declare_in_late's own
  // window (no roll yet for this round) is checked here too, so the button
  // never renders for a state where the RPC would just reject it. Skips the
  // extra roundHasAnyRolls round-trip entirely once either of those is
  // already false.
  const canDeclareLate =
    activeRound?.status === "closed" &&
    !hasDeclared &&
    !(await roundHasAnyRolls(supabase, activeRound.id));

  // Order (issue #226, part of #223): decoupled from declare-in, so this is
  // independent of hasDeclared above. orderRoundId falls back to
  // getMyOrderableRound once there's no activeRound — the Order Window
  // itself stays open through a round's 'resolved' status (ADR 0004), well
  // past the point getActiveRound stops returning it. myOrderForRound wins
  // over the sticky most-recent-across-rooms default, which only matters as
  // a fallback for a round the player hasn't explicitly ordered for yet.
  const orderRoundId = activeRound ? activeRound.id : await getMyOrderableRound(supabase, roomId);
  const myOrderForRound = orderRoundId ? await getMyOrderForRound(supabase, orderRoundId, playerId) : null;
  const myMostRecentOrder =
    orderRoundId && myOrderForRound === null ? await getMyMostRecentOrder(supabase, playerId) : null;

  // Menu (issue #227, part of #223): shares orderRoundId's exact window —
  // it's built from the same round the Order picker targets, so it stays
  // visible through the same open/closed/resolved span the Order Window
  // covers (ADR 0004), not just while activeRound is set. menuParticipants
  // reuses the participants fetch above when the round in question is still
  // activeRound; only needs its own fetch for the post-resolve tail where
  // activeRound has already gone null.
  const menuEntries = orderRoundId ? await getRoundMenu(supabase, orderRoundId) : [];
  const menuParticipants = activeRound
    ? participants
    : orderRoundId
      ? await getRoundParticipants(supabase, orderRoundId)
      : [];

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const heldSpellCards = await getMySpellCards(supabase, roomId);
  // The Spell Draw Window gate (issue #248): only offer the "how did you
  // draw?" choice once the earning round has actually resolved or been
  // cancelled — independent of activeRound, same as rateableRound below,
  // since getActiveRound never returns a resolved round to hang this off of.
  const myPendingSpellDraw = await getMyPendingSpellDraw(supabase);
  const spellCardCatalog = myPendingSpellDraw ? await getSpellCardCatalog(supabase) : [];
  const pendingSpellCasts =
    activeRound && activeRound.status === "closed"
      ? await getMyPendingCasts(supabase, activeRound.id)
      : [];
  const heldReactionCard = heldSpellCards.find((c) => c.location === "held" && c.castingTime === "R") ?? null;

  const openReactionWindow =
    activeRound && activeRound.status === "closed"
      ? await getOpenReactionWindow(supabase, activeRound.id)
      : null;
  const reactionStack =
    openReactionWindow && activeRound ? await getReactionStack(supabase, activeRound.id) : [];
  const reactionWindowPendingPlayers =
    openReactionWindow && activeRound ? await getReactionWindowPendingPlayers(supabase, activeRound.id) : [];

  const dispellableEffects =
    activeRound && activeRound.status === "open"
      ? await getDispellableActiveEffects(supabase, activeRound.id)
      : [];

  const activeEffects = await getRoomActiveEffects(supabase, roomId);
  const effectBadgesByPlayerId = new Map<string, ActiveEffectBadge[]>();
  for (const effect of activeEffects) {
    if (effect.polarity === null) continue;
    const existing = effectBadgesByPlayerId.get(effect.targetPlayerId) ?? [];
    existing.push(effect);
    effectBadgesByPlayerId.set(effect.targetPlayerId, existing);
  }

  const currentLayer = activeRound?.currentLayer ?? 0;
  const isTiePhase = activeRound?.status === "closed" && currentLayer > 0;
  const tiedParticipants =
    activeRound && isTiePhase
      ? await getRoundLayerParticipants(supabase, activeRound.id, currentLayer)
      : [];
  const isTied = tiedParticipants.some((p) => p.playerId === playerId);

  // The caller's own roll for whichever layer is *current* right now (0, or
  // a live reroll) — feeds isPlayersTurnToRoll/rollInputMode/needsRollInput
  // below regardless of phase, and doubles as TieBanner/TieRollModal's
  // ownRoll during a tie.
  const currentLayerOwnRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

  // RoundReveal's own ownRoll is always specifically layer 0's — issue #220
  // piece 4 keeps RoundReveal mounted through the tie phase too (not just
  // after it), so unlike currentLayerOwnRoll above this can't track
  // whichever layer happens to be current; RoundReveal shows layer 0's row
  // as its primary row no matter how many reroll layers came after it.
  // Outside a tie, "the current layer" already *is* layer 0, so
  // currentLayerOwnRoll above is already the answer — only an actual tie
  // phase needs its own extra fetch.
  const layerZeroOwnRoll = !isTiePhase
    ? currentLayerOwnRoll
    : activeRound?.status === "closed" && hasDeclared
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
  const isPlayersTurnToRoll = isExpectedToRoll && currentLayerOwnRoll === null;
  const rollInputMode = isPlayersTurnToRoll ? await getRollInputMode(supabase, playerId) : null;
  const needsRollInput = isPlayersTurnToRoll && !isTiePhase;

  // Independent of the active-round flow above — a player can have a round
  // to rate whether or not today's room currently has one open (issue #211).
  const rateableRound = await getMyRateableRound(supabase, playerId);
  const raterInitials = initialsFrom(player?.display_name ?? null, player?.email ?? user.email ?? "");

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={playerId} />
      <SignOutBadge
        name={player?.display_name ?? player?.email ?? user.email ?? ""}
        showAdminMenu={showAdminMenu}
      />
      <BrewRatingPanel round={rateableRound} raterInitials={raterInitials} />

      {myPendingSpellDraw ? (
        <SpellDrawChoicePanel
          roundId={myPendingSpellDraw.roundId}
          trigger={myPendingSpellDraw.trigger}
          catalogNames={spellCardCatalog.map((c) => c.name)}
          otherCount={myPendingSpellDraw.otherCount}
        />
      ) : null}

      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <Nav active="room" />

      {activeRound ? <SpellCastLive roomId={roomId} roundId={activeRound.id} /> : null}

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        dispellableEffects={dispellableEffects}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
        roomId={roomId}
      />

      {activeRound ? (
        <section className="w-full max-w-md">
          {activeRound.status === "closed" ? (
            <div>
              {isTiePhase && tiedParticipants.length > 0 ? (
                <TieBanner
                  key={currentLayer}
                  roomId={roomId}
                  roundId={activeRound.id}
                  selfPlayerId={playerId}
                  ownRoll={currentLayerOwnRoll}
                  tiedParticipants={tiedParticipants.map((entry) => ({
                    ...entry,
                    modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
                  }))}
                  rollInputMode={rollInputMode}
                />
              ) : null}

              <RoundReveal
                roomId={roomId}
                roundId={activeRound.id}
                selfPlayerId={playerId}
                ownRoll={layerZeroOwnRoll}
                hasOpenReactionWindow={openReactionWindow !== null}
                participants={participants.map((entry) => ({
                  playerId: entry.playerId,
                  displayName: entry.displayName,
                  email: entry.email,
                  modifier: modifierByPlayerId.get(entry.playerId) ?? 0,
                }))}
              />

              {/* Late Declare (issue #246): same "I'm in" button/placement
                  as the open-round path below, reused here for the window
                  between close_round and the round's first roll. Not shown
                  once it would just error (canDeclareLate already checks
                  both hasDeclared and roundHasAnyRolls). */}
              {canDeclareLate ? (
                <form action={declareInLateAction} className="mt-4">
                  <input type="hidden" name="roundId" value={activeRound.id} />
                  <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                    Add me in!
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          ) : (
            <div>
              <RoundOpenLive roomId={roomId} roundId={activeRound.id} />
              <CardFrame title="Who's In?">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                  {roster.map((entry) => (
                    <PlayerTile
                      key={entry.playerId}
                      playerId={entry.playerId}
                      roomId={roomId}
                      displayName={entry.displayName}
                      email={entry.email}
                      avatarUrl={entry.avatarUrl}
                      modifier={entry.modifier}
                      joined={participants.some((p) => p.playerId === entry.playerId)}
                      isStarter={entry.playerId === activeRound.startedBy}
                      effectBadges={effectBadgesByPlayerId.get(entry.playerId) ?? []}
                    />
                  ))}
                </div>

                {/* Declare-in-time cue (issue #226, user story 19): a nudge
                    toward the Order picker below, not a blocker — Order stays
                    fully decoupled from declare/withdraw (ADR 0004), so this
                    only disappears once an Order actually exists for this
                    round, independent of hasDeclared. */}
                {myOrderForRound === null ? (
                  <p className="mt-4 text-xs text-gilt-bright">🫖 Don&rsquo;t forget to set your Order below.</p>
                ) : null}

                {!hasDeclared ? (
                  <form action={declareInAction} className="mt-4">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                      I&rsquo;m in
                    </SubmitButton>
                  </form>
                ) : null}

                {hasDeclared && !isStarter ? (
                  <form action={withdrawDeclarationAction} className="mt-4">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <SubmitButton className="w-full rounded-md border-2 border-gilt-dark bg-transparent px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment disabled:cursor-not-allowed disabled:hover:border-gilt-dark disabled:hover:text-parchment-dim">
                      Not in after all
                    </SubmitButton>
                  </form>
                ) : null}

                {isStarter ? (
                  <form action={closeRoundAction} className="mt-3">
                    <input type="hidden" name="roundId" value={activeRound.id} />
                    <SubmitButton
                      disabled={!canClose}
                      className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark"
                    >
                      {canClose ? "Let's roll" : `Need ${2 - participants.length} more to roll`}
                    </SubmitButton>
                  </form>
                ) : null}
              </CardFrame>
            </div>
          )}

          {needsRollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={activeRound.id} />
          ) : null}
        </section>
      ) : null}

      {/* Decoupled from declare/withdraw (ADR 0004) and from activeRound's
          own open/closed section above — orderRoundId already covers the
          rest of the Order Window (through resolved) via
          getMyOrderableRound once activeRound goes null. */}
      {orderRoundId ? (
        <section className="w-full max-w-md">
          <MenuLive roomId={roomId} roundId={orderRoundId} />
          <OrderPicker
            key={orderRoundId}
            roundId={orderRoundId}
            initialDrinkType={myOrderForRound ?? myMostRecentOrder}
          />
          <RoundMenu entries={menuEntries} participants={menuParticipants} />
        </section>
      ) : null}

      {activeRound && openReactionWindow ? (
        <ReactionBanner
          roomId={roomId}
          roundId={activeRound.id}
          selfPlayerId={playerId}
          eligible={openReactionWindow.eligible}
          alreadyPassed={openReactionWindow.alreadyPassed}
          heldReactionCard={heldReactionCard}
          stack={reactionStack}
          participants={participants}
          pendingPlayers={reactionWindowPendingPlayers}
        />
      ) : null}

      {!activeRound ? (
        <section className="w-full max-w-md">
          <div>
            <RoomIdleLive roomId={roomId} />
            <CardFrame title="The Room">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                {roster.map((entry) => (
                  <PlayerTile
                    key={entry.playerId}
                    playerId={entry.playerId}
                    roomId={roomId}
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    modifier={entry.modifier}
                    effectBadges={effectBadgesByPlayerId.get(entry.playerId) ?? []}
                  />
                ))}
              </div>

              <form action={startRoundAction} className="mt-4">
                <SubmitButton className="w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark">
                  Start Round
                </SubmitButton>
              </form>
            </CardFrame>
          </div>
        </section>
      ) : null}

      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
        <Link href="/settings" className="text-tavern-panel underline hover:text-ember">
          Settings
        </Link>
      </div>
    </main>
  );
}
