import Link from "next/link";
import type { ActiveEffectBadge } from "@/lib/supabase/spellCasts";
import { formatModifier } from "@/lib/game/rollCalculation";
import { firstName } from "@/lib/game/displayName";
import { RollCalculation } from "@/app/_components/RollCalculation";
import { ModifierBreakdown } from "@/app/_components/ModifierBreakdown";

/**
 * A single player's tile — avatar, name, modifier — inside its own small
 * frame (issue #64). Used both for the full daily roster and the "who's in"
 * open-round grid; `joined` lights the tile up to distinguish participants
 * from the rest of the roster in that second view. `effectBadges` (issue
 * #69) renders one dot per active spell-card effect currently on this
 * player — red for negative/debuff, gold for positive/buff — so the roster
 * doubles as an at-a-glance "who's under what effect" view. `revealedRoll`
 * (issue #99) is only passed by TieBanner, once a tied player's reroll comes
 * in — it renders the roll+modifier calculation alongside the raw modifier,
 * rather than leaving them as two values a player has to add up themselves.
 * `playerId`, when passed, makes the avatar a tap target linking to that
 * player's `/collection/:playerId` (issue #135) — used for the room roster
 * grids, not the tied-reroll/reveal views that reuse this same tile. Scoped
 * to just the avatar (not the whole tile) so it doesn't compete with the
 * modifier number's own tap target below.
 * `roomId`, when passed alongside `playerId`, additionally makes the
 * modifier number itself a tap/click target opening the modifier breakdown
 * popover (issue #184).
 */
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
}: {
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  joined?: boolean;
  isStarter?: boolean;
  isTest?: boolean;
  effectBadges?: Exclude<ActiveEffectBadge["polarity"], null>[];
  revealedRoll?: number | null;
  playerId?: string;
  roomId?: string;
}) {
  const name = displayName ?? email;
  // First name only — a long full name wraps to two lines in the tile's
  // fixed width, so show just the first name and truncate with an ellipsis
  // rather than wrap. Full name still shows on hover via the title attribute.
  // displayName === null (email fallback) skips extraction (issue #197) —
  // an email has no surname to drop.
  const firstNameOnly = displayName === null ? name : firstName(displayName);
  const initial = firstNameOnly.trim().charAt(0).toUpperCase() || "?";

  const avatar = (
    <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border-2 border-gilt bg-tavern-plank">
      {avatarUrl ? (
        // next/image requires allowlisting Google's avatar host; a plain
        // <img> avoids that config for a small, user-supplied thumbnail.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="font-display text-lg font-semibold text-gilt-bright">{initial}</span>
      )}
    </div>
  );

  return (
    <div
      className={`flex flex-col items-center gap-1.5 rounded-md border-2 p-3 text-center transition-colors ${
        joined
          ? "border-gilt-bright bg-ember/40 shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
          : "border-gilt-dark bg-tavern-panel-dark"
      }`}
    >
      {playerId ? <Link href={`/collection/${playerId}`}>{avatar}</Link> : avatar}
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
          {effectBadges.map((polarity, index) => (
            <span
              key={index}
              className={`h-2.5 w-2.5 rounded-full ${
                polarity === "negative" ? "bg-red-600" : "bg-gilt-bright"
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
