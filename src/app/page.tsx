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
import { getCompelledCastStep, isExpectedLayerRoller } from "@/lib/supabase/stall";
import {
  closeRoundAction,
  declareInAction,
  declareInLateAction,
  startRoundAction,
  withdrawDeclarationAction,
} from "@/app/rounds/actions";
import { enforceStallTimeout } from "@/app/rounds/stallEnforcement";
import { autoDeclineStalledRoundReplays, getRoomPendingRoundReplay } from "@/lib/supabase/roundReplay";
import { RoundReplayPrompt } from "@/app/rounds/RoundReplayPrompt";
import { RoomIdleLive } from "@/app/rounds/RoomIdleLive";
import { RoundOpenLive } from "@/app/rounds/RoundOpenLive";
import { RoundReveal } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { RoundMenu } from "@/app/rounds/RoundMenu";
import { MenuLive } from "@/app/rounds/MenuLive";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { HeldCardThumbnail } from "@/app/rounds/HeldCardThumbnail";
import { SpellCastLive } from "@/app/rounds/SpellCastLive";
import { SpellDrawChoicePanel } from "@/app/rounds/SpellDrawChoicePanel";
import { PendingSpellDiePanel } from "@/app/rounds/PendingSpellDiePanel";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { CompelledCastPanel } from "@/app/rounds/CompelledCastPanel";
import { TeaPartyRevoltPanel } from "@/app/rounds/TeaPartyRevoltPanel";
import { lastDripNotice } from "@/lib/game/lastDrip";
import { getMyPendingSpellDraw, getMySpellCards, getSpellCardCatalog } from "@/lib/supabase/spellCards";
import {
  type ActiveEffectBadge,
  getDispellableActiveEffects,
  getHeistTargetIds,
  getLastDripPreview,
  getMyCompelledCast,
  getMyPendingCasts,
  getMyPendingSpellDice,
  getRoomActiveEffects,
  getTeaPartyRevoltPicker,
} from "@/lib/supabase/spellCasts";
import {
  getMyCourageTokens,
  getOpenReactionWindow,
  getReactionSkipVote,
  getReactionStack,
  getReactionWindowPendingPlayers,
} from "@/lib/supabase/reactionWindow";
import { getMyRateableRound } from "@/lib/supabase/brewRatings";
import { getRoomRounds } from "@/lib/supabase/stats";
import { RoundRecapHistory } from "@/app/_components/RoundRecapHistory";
import { initialsFrom } from "@/lib/game/initials";
import { Nav } from "@/app/Nav";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { SignOutBadge } from "@/app/_components/SignOutBadge";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { BrewRatingPanel } from "@/app/_components/BrewRatingPanel";
import { RoomViewProvider } from "@/lib/room/RoomViewProvider";
import { loadInitialRoomView } from "@/lib/room/loadInitialRoomView";
import { RoomScreen } from "@/app/rounds/RoomScreen";

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

  const initialView = await loadInitialRoomView(supabase, roomId);
  if (initialView) {
    const signOutName = player?.display_name ?? player?.email ?? user.email ?? "";
    return (
      <RoomViewProvider roomId={roomId} initialView={initialView}>
        <RoomScreen
          variant="home"
          raterInitials={initialsFrom(player?.display_name ?? null, player?.email ?? user.email ?? "")}
          top={
            <>
              <ParallaxBackdrop playerId={playerId} />
              <SignOutBadge name={signOutName} showAdminMenu={showAdminMenu} />
            </>
          }
          afterTopPanels={
            <>
              <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
                Roll for Brew
              </h1>
              <Nav active="room" />
            </>
          }
          bottom={
            <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest">
              <Link href="/settings" className="text-tavern-panel underline hover:text-ember">
                Settings
              </Link>
            </div>
          }
        />
      </RoomViewProvider>
    );
  }

  const roster = await getRoomRoster(supabase, roomId);

  await autoDeclineStalledRoundReplays(supabase);
  const pendingRoundReplay = await getRoomPendingRoundReplay(supabase, roomId);
  const pendingReplayCaster = pendingRoundReplay
    ? roster.find((entry) => entry.playerId === pendingRoundReplay.casterId) ?? null
    : null;

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

  const canDeclareLate =
    activeRound?.status === "closed" &&
    !hasDeclared &&
    !(await roundHasAnyRolls(supabase, activeRound.id));

  const orderRoundId = activeRound ? activeRound.id : await getMyOrderableRound(supabase, roomId);
  const myOrderForRound = orderRoundId ? await getMyOrderForRound(supabase, orderRoundId, playerId) : null;
  const myMostRecentOrder =
    orderRoundId && myOrderForRound === null ? await getMyMostRecentOrder(supabase, playerId) : null;

  const menuEntries = orderRoundId ? await getRoundMenu(supabase, orderRoundId) : [];
  const menuParticipants = activeRound
    ? participants
    : orderRoundId
      ? await getRoundParticipants(supabase, orderRoundId)
      : [];

  const modifierByPlayerId = new Map(roster.map((entry) => [entry.playerId, entry.modifier]));

  const heldSpellCards = await getMySpellCards(supabase, roomId);
  const myPendingSpellDraw = await getMyPendingSpellDraw(supabase);
  const spellCardCatalog = myPendingSpellDraw ? await getSpellCardCatalog(supabase) : [];
  const pendingSpellCasts =
    activeRound && activeRound.status === "closed"
      ? await getMyPendingCasts(supabase, activeRound.id)
      : [];
  const heldReactionCard = heldSpellCards.find((c) => c.location === "held" && c.castingTime === "R") ?? null;

  const myPendingSpellDice = activeRound ? await getMyPendingSpellDice(supabase, activeRound.id) : [];
  const spellDieRollInputMode =
    myPendingSpellDice.length > 0 ? await getRollInputMode(supabase, playerId) : null;

  const openReactionWindow =
    activeRound && activeRound.status === "closed"
      ? await getOpenReactionWindow(supabase, activeRound.id)
      : null;
  const reactionStack =
    openReactionWindow && activeRound ? await getReactionStack(supabase, activeRound.id) : [];
  const reactionWindowPendingPlayers =
    openReactionWindow && activeRound ? await getReactionWindowPendingPlayers(supabase, activeRound.id) : [];
  const reactionSkipVote =
    openReactionWindow && activeRound ? await getReactionSkipVote(supabase, activeRound.id) : null;
  const myCourageTokens =
    openReactionWindow?.layer === 0 && activeRound ? await getMyCourageTokens(supabase, activeRound.id) : [];

  const compelledRound = activeRound?.status === "closed" && activeRound.currentLayer === 0 ? activeRound : null;
  const myCompelledCast = compelledRound ? await getMyCompelledCast(supabase, compelledRound.id) : null;
  const compelledStep = compelledRound ? await getCompelledCastStep(supabase, compelledRound.id) : null;

  const revoltPickerId = compelledRound ? await getTeaPartyRevoltPicker(supabase, compelledRound.id) : null;

  const dispellableEffects =
    activeRound && (activeRound.status === "open" || myCompelledCast?.castingTime === "A")
      ? await getDispellableActiveEffects(supabase, activeRound.id)
      : [];

  const heistTargetIds =
    activeRound &&
    (activeRound.status === "open" || myCompelledCast?.castingTime === "A") &&
    heldSpellCards.some((c) => c.location === "held" && c.cardName === "Tea Heist")
      ? await getHeistTargetIds(supabase, activeRound.id)
      : [];

  const lastDripPreview =
    activeRound &&
    (activeRound.status === "open" || myCompelledCast?.castingTime === "A") &&
    heldSpellCards.some((c) => c.location === "held" && c.cardName === "Last Drip")
      ? await getLastDripPreview(supabase, activeRound.id)
      : null;

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

  const currentLayerOwnRoll = !activeRound
    ? null
    : isTiePhase
      ? isTied
        ? await getOwnRoll(supabase, activeRound.id, playerId, currentLayer)
        : null
      : activeRound.status === "closed" && hasDeclared
        ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
        : null;

  const layerZeroOwnRoll = !isTiePhase
    ? currentLayerOwnRoll
    : activeRound?.status === "closed" && hasDeclared
      ? await getOwnRoll(supabase, activeRound.id, playerId, 0)
      : null;

  const isExpectedToRoll =
    activeRound?.status === "closed"
      ? await isExpectedLayerRoller(supabase, activeRound.id, playerId, currentLayer)
      : false;
  const isPlayersTurnToRoll = isExpectedToRoll && currentLayerOwnRoll === null;
  const rollInputMode = isPlayersTurnToRoll ? await getRollInputMode(supabase, playerId) : null;
  const needsRollInput = isPlayersTurnToRoll && !isTiePhase;

  const rateableRound = await getMyRateableRound(supabase, playerId);
  const raterInitials = initialsFrom(player?.display_name ?? null, player?.email ?? user.email ?? "");

  const roomRounds = await getRoomRounds(supabase, roomId);
  const recapHistoryEntries = roomRounds.map((r) => ({
    roundId: r.roundId,
    resolvedAt: r.resolvedAt,
    cupsMade: r.cupsMade,
    brewerName: r.brewerDisplayName ?? r.brewerEmail,
  }));
  const namesByPlayerId: Record<string, string> = Object.fromEntries(
    roster.map((entry) => [entry.playerId, entry.displayName ?? entry.email]),
  );
  const castNotice = lastDripNotice(lastDripPreview, (id) => namesByPlayerId[id] ?? "A player");

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId={playerId} />
      <SignOutBadge
        name={player?.display_name ?? player?.email ?? user.email ?? ""}
        showAdminMenu={showAdminMenu}
      />
      <BrewRatingPanel round={rateableRound} raterInitials={raterInitials} />
      {orderRoundId ? <RoundMenu entries={menuEntries} participants={menuParticipants} /> : null}

      {myPendingSpellDraw ? (
        <SpellDrawChoicePanel
          roundId={myPendingSpellDraw.roundId}
          trigger={myPendingSpellDraw.trigger}
          catalogNames={spellCardCatalog.map((c) => c.name)}
          otherCount={myPendingSpellDraw.otherCount}
        />
      ) : null}

      {pendingRoundReplay ? (
        <RoundReplayPrompt
          roomId={roomId}
          roundId={pendingRoundReplay.roundId}
          isCaster={pendingRoundReplay.casterId === playerId}
          casterDisplayName={pendingReplayCaster?.displayName ?? null}
        />
      ) : null}

      {activeRound && spellDieRollInputMode ? (
        <PendingSpellDiePanel
          roundId={activeRound.id}
          pendingDice={myPendingSpellDice}
          rollInputMode={spellDieRollInputMode}
        />
      ) : null}

      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <Nav active="room" />

      {activeRound ? <SpellCastLive roomId={roomId} roundId={activeRound.id} /> : null}

      {compelledRound ? (
        <CompelledCastPanel
          roundId={compelledRound.id}
          compelled={myCompelledCast}
          held={heldSpellCards.find((c) => c.location === "held") ?? null}
          brewmageddonCasterName={
            myCompelledCast ? (namesByPlayerId[myCompelledCast.brewmageddonCasterId] ?? "Someone") : ""
          }
          waitingOnNames={(compelledStep?.waitingOn ?? [])
            .filter((id) => id !== playerId)
            .map((id) => namesByPlayerId[id] ?? id)}
          participants={participants}
          selfPlayerId={playerId}
          dispellableEffects={dispellableEffects}
          heistTargetIds={heistTargetIds}
          castNotice={castNotice}
        />
      ) : null}

      {activeRound && revoltPickerId ? (
        <TeaPartyRevoltPanel
          roundId={activeRound.id}
          pickerId={revoltPickerId}
          pickerName={namesByPlayerId[revoltPickerId] ?? "The lowest roller"}
          selfPlayerId={playerId}
          participants={participants}
        />
      ) : null}

      <SpellCardPanel
        heldCards={heldSpellCards}
        pendingCasts={pendingSpellCasts}
        roundId={activeRound?.id ?? null}
        roundIsClosed={activeRound?.status === "closed"}
        participants={participants}
        selfPlayerId={playerId}
        roomId={roomId}
      />
      <HeldCardThumbnail
        heldCards={heldSpellCards}
        dispellableEffects={dispellableEffects}
        roundId={activeRound?.id ?? null}
        roundIsOpen={activeRound?.status === "open"}
        participants={participants}
        heistTargetIds={heistTargetIds}
        castNotice={castNotice}
        selfPlayerId={playerId}
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
                      selfPlayerId={playerId}
                      orderRoundId={orderRoundId ?? undefined}
                      orderInitialDrinkType={myOrderForRound ?? myMostRecentOrder}
                    />
                  ))}
                </div>

                {myOrderForRound === null ? (
                  <p className="mt-4 text-xs text-gilt-bright">🫖 Don&rsquo;t forget to set your Order above.</p>
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

      {orderRoundId ? (
        <section className="w-full max-w-md">
          <MenuLive roomId={roomId} roundId={orderRoundId} />
        </section>
      ) : null}

      <RoundRecapHistory entries={recapHistoryEntries} namesByPlayerId={namesByPlayerId} />

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
          skipVote={reactionSkipVote}
          compelled={myCompelledCast?.castingTime === "R"}
          courageTokens={myCourageTokens}
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
                    selfPlayerId={playerId}
                    orderRoundId={orderRoundId ?? undefined}
                    orderInitialDrinkType={myOrderForRound ?? myMostRecentOrder}
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
