import Link from "next/link";
import type { ActiveEffectBadge } from "@/lib/supabase/spellCasts";
import type { DrinkType } from "@/lib/supabase/orders";
import { formatModifier } from "@/lib/game/rollCalculation";
import { firstNameOrFallback } from "@/lib/game/displayName";
import { RollCalculation } from "@/app/_components/RollCalculation";
import { ModifierBreakdown } from "@/app/_components/ModifierBreakdown";
import { EffectBadgePopover } from "@/app/_components/EffectBadgePopover";
import { AvatarOrderPicker } from "@/app/_components/AvatarOrderPicker";

export function PlayerTile({
  displayName,
  email,
  avatarUrl,
  modifier,
  joined = false,
  isStarter = false,
  isTest = false,
  effectBadges = [],
  revealedRoll = null,
  playerId,
  roomId,
  selfPlayerId,
  orderRoundId,
  orderInitialDrinkType = null,
}: {
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  joined?: boolean;
  isStarter?: boolean;
  isTest?: boolean;
  effectBadges?: ActiveEffectBadge[];
  revealedRoll?: number | null;
  playerId?: string;
  roomId?: string;
  selfPlayerId?: string;
  orderRoundId?: string;
  orderInitialDrinkType?: DrinkType | null;
}) {
  const name = displayName ?? email;
  const firstNameOnly = firstNameOrFallback(displayName, email);
  const initial = firstNameOnly.trim().charAt(0).toUpperCase() || "?";

  const avatar = (
    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border-2 border-gilt bg-tavern-plank">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="font-display text-lg font-semibold text-gilt-bright">{initial}</span>
      )}
    </div>
  );

  const avatarLinked = playerId ? <Link href={`/${playerId}`}>{avatar}</Link> : avatar;
  const isSelf = Boolean(playerId) && playerId === selfPlayerId;
  const avatarWithOrderControls =
    isSelf && orderRoundId ? (
      <AvatarOrderPicker key={orderRoundId} roundId={orderRoundId} initialDrinkType={orderInitialDrinkType}>
        {avatarLinked}
      </AvatarOrderPicker>
    ) : (
      avatarLinked
    );

  return (
    <div
      className={`flex flex-col items-center gap-1.5 rounded-md border-2 p-3 text-center transition-colors ${
        joined
          ? "border-gilt-bright bg-ember/40 shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
          : "border-gilt-dark bg-tavern-panel-dark"
      }`}
    >
      {avatarWithOrderControls}
      <span className="w-full truncate text-xs leading-tight text-parchment" title={name}>
        {firstNameOnly}
        {isStarter ? <span className="text-gilt"> ★</span> : null}
      </span>
      {isTest ? (
        <span className="rounded-sm bg-tavern-plank px-1.5 py-0.5 font-display text-[10px] uppercase tracking-widest text-parchment-dim">
          Test
        </span>
      ) : null}
      {playerId && roomId ? (
        <ModifierBreakdown playerId={playerId} roomId={roomId} modifier={modifier} />
      ) : (
        <span className="font-mono text-xs text-parchment-dim">{formatModifier(modifier)}</span>
      )}
      {revealedRoll !== null ? <RollCalculation roll={revealedRoll} modifier={modifier} /> : null}
      {effectBadges.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-1" aria-label="active effects">
          {effectBadges.map((effect) => (
            <EffectBadgePopover key={effect.effectId} effect={effect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
