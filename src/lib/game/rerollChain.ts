import { resolveLayer, type LayerEntry } from "@/lib/game/resolveLayer";
import type { CompletedLayer } from "@/lib/supabase/rolls";

export type RerollChainLevel = {
  layer: number;
  roll: number;
  modifier: number;
  // true if this level's own reroll also tied (so the chain continues to
  // `layer + 1` — present in `history` once that layer completes too); false
  // once this level resolved the tie outright, terminating the chain.
  tied: boolean;
};

/**
 * Walks a round's full layer history (issue #220's get_round_layer_history,
 * src/lib/supabase/rolls.ts) to build one player's reroll chain: every layer
 * beyond layer 0 they were tied into, in order, each tagged with whether
 * that level tied again (chain continues) or resolved (chain ends) — reusing
 * resolveLayer (the same nat-1/nat-20/lowest-total rule the server itself
 * used to decide it) so a level's outcome here can never disagree with what
 * actually happened.
 *
 * Layer 0 itself is never included — RoundReveal already renders it as the
 * player's primary row; this only covers the *dependent* rows nested under
 * it. A layer that hasn't completed yet (history withholds it — see
 * get_round_layer_history's header comment) simply isn't in `history`, so
 * the walk stops there and returns whatever's been revealed so far.
 */
export function buildRerollChain(playerId: string, history: CompletedLayer[]): RerollChainLevel[] {
  const rollsByLayer = new Map(history.map((completed) => [completed.layer, completed.rolls]));
  const chain: RerollChainLevel[] = [];

  let layer = 0;
  for (;;) {
    const rolls = rollsByLayer.get(layer);
    if (!rolls) break;

    const own = rolls.find((r) => r.playerId === playerId);
    if (!own) break;

    const entries: LayerEntry[] = rolls.map((r) => ({
      playerId: r.playerId,
      roll: r.value,
      modifier: r.modifierSnapshot,
    }));
    const tied = resolveLayer(entries).outcome === "tie";

    if (layer > 0) {
      chain.push({ layer, roll: own.value, modifier: own.modifierSnapshot, tied });
    }

    if (!tied) break;
    layer += 1;
  }

  return chain;
}
