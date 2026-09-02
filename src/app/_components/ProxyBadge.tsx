/**
 * Provenance chip for a roll an admin entered on a player's behalf (issue
 * #273's Proxy Roll) rather than the player submitting it themselves. Shown
 * wherever a roll value is — the live reveal roster and the scrapped
 * generation-0 disclosure (issue #352).
 */
export function ProxyBadge() {
  return (
    <span
      className="w-fit rounded-sm border border-gilt-dark px-1 font-display text-[9px] uppercase tracking-widest text-parchment-dim"
      title="Entered by an admin on this player's behalf"
    >
      Proxy
    </span>
  );
}
