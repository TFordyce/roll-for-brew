import type { ActiveEffectBadge } from "@/lib/supabase/spellCasts";

/**
 * A single player's tile — avatar, name, modifier — inside its own small
 * frame (issue #64). Used both for the full daily roster and the "who's in"
 * open-round grid; `joined` lights the tile up to distinguish participants
 * from the rest of the roster in that second view. `effectBadges` (issue
 * #69) renders one dot per active spell-card effect currently on this
 * player — red for negative/debuff, gold for positive/buff — so the roster
 * doubles as an at-a-glance "who's under what effect" view.
 */
export function PlayerTile({
  displayName,
  email,
  avatarUrl,
  modifier,
  joined = false,
  isStarter = false,
  effectBadges = [],
}: {
  displayName: string | null;
  email: string;
  avatarUrl: string | null;
  modifier: number;
  joined?: boolean;
  isStarter?: boolean;
  effectBadges?: Exclude<ActiveEffectBadge["polarity"], null>[];
}) {
  const name = displayName ?? email;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className={`flex flex-col items-center gap-1.5 rounded-md border-2 p-3 text-center transition-colors ${
        joined
          ? "border-gilt-bright bg-ember/40 shadow-[0_0_10px_theme(colors.gilt.DEFAULT)]"
          : "border-gilt-dark bg-tavern-panel-dark"
      }`}
    >
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
      <span className="w-full break-words text-xs leading-tight text-parchment">
        {name}
        {isStarter ? <span className="text-gilt"> ★</span> : null}
      </span>
      <span className="font-mono text-xs text-parchment-dim">{modifier >= 0 ? `+${modifier}` : modifier}</span>
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
