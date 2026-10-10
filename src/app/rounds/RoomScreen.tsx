"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRoomView, useRoomViewStore } from "@/lib/room/roomViewContext";
import type { RoomView } from "@/lib/room/roomViewStore";
import { lastDripNotice } from "@/lib/game/lastDrip";
import { SKIP_VOTE_GRACE_MS } from "@/lib/game/skipVote";
import type { MenuEntry } from "@/lib/supabase/menu";
import type { DrinkType } from "@/lib/supabase/orders";
import type { RollInputMode } from "@/lib/supabase/playerSettings";
import type { ReactionStackEntry } from "@/lib/supabase/reactionWindow";
import type { HeldSpellCard } from "@/lib/supabase/spellCards";
import type { ActiveEffectBadge, CompelledCast, DispellableEffect, PendingCast } from "@/lib/supabase/spellCasts";
import type { LastDripPreview } from "@/lib/supabase/rolls";
import type { RoundParticipant } from "@/lib/supabase/rounds";
import {
  closeRoundAction,
  declareInAction,
  declareInLateAction,
  startRoundAction,
  withdrawDeclarationAction,
} from "@/app/rounds/actions";
import { RoundReplayPrompt } from "@/app/rounds/RoundReplayPrompt";
import { RoundReveal, type RoundRevealParticipant } from "@/app/rounds/RoundReveal";
import { RollInputPicker } from "@/app/rounds/RollInputPicker";
import { OrderPicker } from "@/app/rounds/OrderPicker";
import { RoundMenu } from "@/app/rounds/RoundMenu";
import { TieBanner } from "@/app/rounds/TieBanner";
import { SpellCardPanel } from "@/app/rounds/SpellCardPanel";
import { HeldCardThumbnail } from "@/app/rounds/HeldCardThumbnail";
import { SpellDrawChoicePanel } from "@/app/rounds/SpellDrawChoicePanel";
import { PendingSpellDiePanel } from "@/app/rounds/PendingSpellDiePanel";
import { ReactionBanner } from "@/app/rounds/ReactionBanner";
import { CompelledCastPanel } from "@/app/rounds/CompelledCastPanel";
import { TeaPartyRevoltPanel } from "@/app/rounds/TeaPartyRevoltPanel";
import { RoundRecapHistory } from "@/app/_components/RoundRecapHistory";
import { CardFrame } from "@/app/_components/CardFrame";
import { PlayerTile } from "@/app/_components/PlayerTile";
import { SubmitButton } from "@/app/_components/SubmitButton";
import { BrewRatingPanel } from "@/app/_components/BrewRatingPanel";
import { LiveRollForOthers } from "@/app/admin/test-room/LiveRollForOthers";

const PRIMARY_BUTTON =
  "w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim disabled:hover:bg-tavern-panel-dark";
const SECONDARY_BUTTON =
  "w-full rounded-md border-2 border-gilt-dark bg-transparent px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment disabled:cursor-not-allowed disabled:hover:border-gilt-dark disabled:hover:text-parchment-dim";

type HeldReveal = { roundId: string; participants: RoundRevealParticipant[] };

export function RoomScreen({
  variant,
  top,
  afterTopPanels,
  bottom,
  raterInitials = "",
}: {
  variant: "home" | "testRoom";
  top: ReactNode;
  afterTopPanels: ReactNode;
  bottom: ReactNode;
  raterInitials?: string;
}) {
  const view = useRoomView();
  const store = useRoomViewStore();
  const { room, viewer } = view;
  const roomId = room.roomId;
  const selfPlayerId = viewer.playerId;
  const active = room.activeRound;
  const isTestRoom = variant === "testRoom";

  const roster = room.roster.map((r) => ({
    playerId: r.playerId,
    displayName: r.displayName,
    email: r.email ?? "",
    avatarUrl: r.avatarUrl,
    modifier: Number(r.modifier),
    isTest: r.isTest,
    effectBadges: r.effectBadges.map(
      (b): ActiveEffectBadge => ({
        effectId: b.effectId,
        targetPlayerId: r.playerId,
        cardName: b.cardName,
        tier: b.tier as ActiveEffectBadge["tier"],
        polarity: b.polarity as ActiveEffectBadge["polarity"],
        roundsRemaining: Number(b.roundsRemaining ?? 0),
      }),
    ),
  }));
  const namesByPlayerId: Record<string, string> = Object.fromEntries(
    roster.map((r) => [r.playerId, r.displayName ?? r.email]),
  );
  const nameOf = (id: string, fallback = "Someone") => namesByPlayerId[id] ?? fallback;
  const modifierByPlayerId = new Map(roster.map((r) => [r.playerId, r.modifier]));

  const participants: RoundParticipant[] = (active?.participants ?? []).map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
    email: p.email ?? "",
    avatarUrl: p.avatarUrl,
    declaredAt: p.declaredAt,
    excludedAt: p.excludedAt,
  }));
  const joinedIds = new Set(participants.map((p) => p.playerId));
  const revealParticipants: RoundRevealParticipant[] = (active?.participants ?? []).map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
    email: p.email ?? "",
    modifier: modifierByPlayerId.get(p.playerId) ?? Number(p.modifier),
  }));

  const heldCards = viewer.heldCards as HeldSpellCard[];
  const dispellableEffects = viewer.dispellableEffects as DispellableEffect[];
  const currentLayer = active ? Number(active.currentLayer) : 0;
  const rollInputMode = viewer.rollInputMode as RollInputMode | null;
  const drinkDefault = (viewer.myOrderForRound ?? viewer.myMostRecentOrder) as DrinkType | null;
  const lastDrip: LastDripPreview | null = viewer.lastDripPreview
    ? {
        targetPlayerId: viewer.lastDripPreview.targetPlayerId,
        reason: viewer.lastDripPreview.reason as LastDripPreview["reason"],
        passedOver: (viewer.lastDripPreview.passedOver ?? []).map((p) => ({
          playerId: p.playerId,
          reason: p.reason as "absent" | "roll_exempt",
        })),
      }
    : null;
  const castNotice = lastDripNotice(lastDrip, (id) => nameOf(id, "A player"));

  const [held, setHeld] = useState<HeldReveal | null>(null);
  const latestReveal = useRef<HeldReveal | null>(null);
  latestReveal.current = active ? { roundId: active.roundId, participants: revealParticipants } : null;
  const holdReveal = useCallback(() => {
    if (latestReveal.current) setHeld(latestReveal.current);
  }, []);
  const releaseReveal = useCallback(() => {
    setHeld(null);
    store?.refetch();
  }, [store]);
  useEffect(() => {
    if (active && held) setHeld(null);
  }, [active, held]);
  const heldReveal = !active ? held : null;

  const showClosed = active?.status === "closed";
  const tiedParticipants = (active?.tiedParticipants ?? []).map((t) => ({
    playerId: t.playerId,
    displayName: t.displayName,
    email: t.email ?? "",
    avatarUrl: t.avatarUrl,
    modifier: Number(t.modifier),
    excludedAt: t.excludedAt,
  }));
  const compelled = viewer.compelledCast;
  const reaction = viewer.reaction;
  const revealRoundId = active?.roundId ?? heldReveal?.roundId ?? null;

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      {top}

      {!isTestRoom ? (
        <BrewRatingPanel
          round={
            viewer.rateableRound
              ? {
                  roundId: viewer.rateableRound.roundId,
                  brewerDisplayName: viewer.rateableRound.brewerDisplayName,
                  brewerEmail: viewer.rateableRound.brewerEmail ?? "",
                  resolvedAt: viewer.rateableRound.resolvedAt,
                  myScore: viewer.rateableRound.myScore === null ? null : Number(viewer.rateableRound.myScore),
                }
              : null
          }
          raterInitials={raterInitials}
        />
      ) : null}

      {viewer.panels.menu ? (
        <RoundMenu
          entries={viewer.menu as MenuEntry[]}
          participants={viewer.menuParticipants.map((p) => ({
            playerId: p.playerId,
            displayName: p.displayName,
            email: p.email ?? "",
          }))}
        />
      ) : null}

      {viewer.pendingSpellDraw ? (
        <SpellDrawChoicePanel
          roundId={viewer.pendingSpellDraw.roundId}
          trigger={viewer.pendingSpellDraw.trigger as "nat1" | "nat20"}
          catalogNames={viewer.pendingSpellDraw.catalogNames}
          otherCount={Number(viewer.pendingSpellDraw.otherCount)}
        />
      ) : null}

      {viewer.pendingRoundReplay ? (
        <RoundReplayPrompt
          roomId={roomId}
          roundId={viewer.pendingRoundReplay.roundId}
          isCaster={viewer.pendingRoundReplay.isCaster}
          casterDisplayName={viewer.pendingRoundReplay.casterDisplayName}
        />
      ) : null}

      {active && viewer.panels.pendingSpellDie && viewer.spellDieRollInputMode ? (
        <PendingSpellDiePanel
          roundId={active.roundId}
          pendingDice={viewer.pendingSpellDice}
          rollInputMode={viewer.spellDieRollInputMode as RollInputMode}
        />
      ) : null}

      {afterTopPanels}

      {active && viewer.panels.compelledCast ? (
        <CompelledCastPanel
          roundId={active.roundId}
          compelled={(compelled?.mine ?? null) as CompelledCast | null}
          held={heldCards.find((c) => c.location === "held") ?? null}
          brewmageddonCasterName={compelled?.mine ? nameOf(compelled.mine.brewmageddonCasterId) : ""}
          waitingOnNames={(compelled?.waitingOnOthers ?? [])
            .filter((id) => id !== selfPlayerId)
            .map((id) => namesByPlayerId[id] ?? id)}
          participants={participants}
          selfPlayerId={selfPlayerId}
          dispellableEffects={dispellableEffects}
          heistTargetIds={viewer.heistTargetIds}
          castNotice={castNotice}
        />
      ) : null}

      {active && viewer.teaPartyRevoltPickerId ? (
        <TeaPartyRevoltPanel
          roundId={active.roundId}
          pickerId={viewer.teaPartyRevoltPickerId}
          pickerName={nameOf(viewer.teaPartyRevoltPickerId, "The lowest roller")}
          selfPlayerId={selfPlayerId}
          participants={participants}
        />
      ) : null}

      <SpellCardPanel
        heldCards={heldCards}
        pendingCasts={viewer.pendingCasts as PendingCast[]}
        roundId={active?.roundId ?? null}
        roundIsClosed={showClosed}
        participants={participants}
        selfPlayerId={selfPlayerId}
        roomId={roomId}
      />
      <HeldCardThumbnail
        heldCards={heldCards}
        dispellableEffects={dispellableEffects}
        roundId={active?.roundId ?? null}
        roundIsOpen={active?.status === "open"}
        participants={participants}
        heistTargetIds={viewer.heistTargetIds}
        castNotice={castNotice}
        selfPlayerId={selfPlayerId}
      />

      {active || heldReveal ? (
        <section className="w-full max-w-md">
          {showClosed || heldReveal ? (
            <div>
              {active && viewer.panels.tieBanner ? (
                <TieBanner
                  key={currentLayer}
                  roomId={roomId}
                  roundId={active.roundId}
                  selfPlayerId={selfPlayerId}
                  ownRoll={viewer.ownRoll === null ? null : Number(viewer.ownRoll)}
                  tiedParticipants={tiedParticipants}
                  rollInputMode={rollInputMode}
                />
              ) : null}

              {revealRoundId ? (
                <RoundReveal
                  roomId={roomId}
                  roundId={revealRoundId}
                  selfPlayerId={selfPlayerId}
                  ownRoll={viewer.layerZeroOwnRoll === null ? null : Number(viewer.layerZeroOwnRoll)}
                  hasOpenReactionWindow={reaction !== null}
                  participants={active ? revealParticipants : (heldReveal?.participants ?? [])}
                  onRevealed={holdReveal}
                  onResultsDone={releaseReveal}
                />
              ) : null}

              {viewer.panels.lateDeclare && active ? (
                <form action={declareInLateAction} className="mt-4">
                  <input type="hidden" name="roundId" value={active.roundId} />
                  <SubmitButton className={PRIMARY_BUTTON}>Add me in!</SubmitButton>
                </form>
              ) : null}
            </div>
          ) : active ? (
            <div>
              <CardFrame title="Who's In?">
                <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                  {roster.map((entry) => (
                    <PlayerTile
                      key={entry.playerId}
                      displayName={entry.displayName}
                      email={entry.email}
                      avatarUrl={entry.avatarUrl}
                      modifier={entry.modifier}
                      joined={joinedIds.has(entry.playerId)}
                      isStarter={entry.playerId === active.startedBy}
                      effectBadges={entry.effectBadges}
                      {...(isTestRoom
                        ? {}
                        : {
                            playerId: entry.playerId,
                            roomId,
                            selfPlayerId,
                            orderRoundId: viewer.orderRoundId ?? undefined,
                            orderInitialDrinkType: drinkDefault,
                          })}
                    />
                  ))}
                </div>

                {viewer.orderCue ? (
                  <p className="mt-4 text-xs text-gilt-bright">
                    🫖 Don&rsquo;t forget to set your Order {isTestRoom ? "below" : "above"}.
                  </p>
                ) : null}

                {viewer.canDeclare ? (
                  <form action={declareInAction} className="mt-4">
                    <input type="hidden" name="roundId" value={active.roundId} />
                    <SubmitButton className={PRIMARY_BUTTON}>I&rsquo;m in</SubmitButton>
                  </form>
                ) : null}

                {viewer.canWithdraw ? (
                  <form action={withdrawDeclarationAction} className="mt-4">
                    <input type="hidden" name="roundId" value={active.roundId} />
                    <SubmitButton className={SECONDARY_BUTTON}>Not in after all</SubmitButton>
                  </form>
                ) : null}

                {viewer.isStarter ? (
                  <form action={closeRoundAction} className="mt-3">
                    <input type="hidden" name="roundId" value={active.roundId} />
                    <SubmitButton disabled={!viewer.canClose} className={PRIMARY_BUTTON}>
                      {viewer.canClose ? "Let's roll" : `Need ${Number(viewer.needMoreToClose)} more to roll`}
                    </SubmitButton>
                  </form>
                ) : null}
              </CardFrame>
            </div>
          ) : null}

          {active && viewer.panels.rollInput && rollInputMode ? (
            <RollInputPicker mode={rollInputMode} roundId={active.roundId} />
          ) : null}

          {isTestRoom && active ? <LiveRollForOthers view={view} /> : null}
        </section>
      ) : null}

      {isTestRoom && viewer.orderRoundId ? (
        <section className="w-full max-w-md">
          <OrderPicker key={viewer.orderRoundId} roundId={viewer.orderRoundId} initialDrinkType={drinkDefault} />
        </section>
      ) : null}

      <RoundRecapHistory
        entries={room.history.map((h) => ({
          roundId: h.roundId,
          resolvedAt: h.resolvedAt ?? "",
          cupsMade: Number(h.cupsMade ?? 0),
          brewerName: h.brewerName ?? "",
        }))}
        namesByPlayerId={namesByPlayerId}
      />

      {active && reaction ? (
        <ReactionBanner
          roomId={roomId}
          roundId={active.roundId}
          selfPlayerId={selfPlayerId}
          eligible={reaction.eligible}
          alreadyPassed={reaction.alreadyPassed}
          heldReactionCard={viewer.heldReactionCard as HeldSpellCard | null}
          stack={reaction.stack.map(
            (s): ReactionStackEntry => ({
              castId: s.castId,
              cardName: s.cardName,
              casterId: s.casterId,
              casterName: s.casterName,
              targetStamp: s.targetStamp as ReactionStackEntry["targetStamp"],
              negated: s.negated,
              parentCastId: s.parentCastId,
              seq: Number(s.seq),
            }),
          )}
          participants={participants}
          pendingPlayers={reaction.pendingPlayers}
          skipVote={
            reaction.skipVote
              ? {
                  votes: Number(reaction.skipVote.votes),
                  threshold: Number(reaction.skipVote.threshold),
                  hasVoted: reaction.skipVote.hasVoted,
                  canVote: reaction.skipVote.canVote,
                  waitedOn: reaction.skipVote.waitedOn,
                  graceEndsAt: new Date(Date.parse(reaction.skipVote.pollRoundStartedAt) + SKIP_VOTE_GRACE_MS),
                }
              : null
          }
          compelled={reaction.compelled}
          courageTokens={reaction.courageTokens}
        />
      ) : null}

      {!active && !heldReveal ? (
        <section className="w-full max-w-md">
          <div>
            <CardFrame title={isTestRoom ? "Test Roster" : "The Room"}>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
                {roster.map((entry) => (
                  <PlayerTile
                    key={entry.playerId}
                    displayName={entry.displayName}
                    email={entry.email}
                    avatarUrl={entry.avatarUrl}
                    modifier={entry.modifier}
                    effectBadges={entry.effectBadges}
                    {...(isTestRoom
                      ? { isTest: entry.isTest }
                      : {
                          playerId: entry.playerId,
                          roomId,
                          selfPlayerId,
                          orderRoundId: viewer.orderRoundId ?? undefined,
                          orderInitialDrinkType: drinkDefault,
                        })}
                  />
                ))}
              </div>

              {viewer.canStartRound ? (
                <form action={startRoundAction} className="mt-4">
                  {isTestRoom ? <input type="hidden" name="roomId" value={roomId} /> : null}
                  <SubmitButton className={PRIMARY_BUTTON}>Start Round</SubmitButton>
                </form>
              ) : null}
            </CardFrame>
          </div>
        </section>
      ) : null}

      {bottom}
    </main>
  );
}
