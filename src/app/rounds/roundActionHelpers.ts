import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { drawSpellCardAs, recordPendingSpellDraw } from "@/lib/supabase/spellCards";
import { hasLayerZeroReactionWindow } from "@/lib/supabase/spellCasts";
import { finalizeReactionWindow, resolveCompletedLayerIfAny } from "@/app/rounds/layerResolution";

/**
 * Every action here can be triggered from either real gameplay's "/" or,
 * for an admin puppeting a Test Player (issue #102), "/admin/test-room" —
 * revalidate both unconditionally rather than threading "which page called
 * this" through every action just to pick one.
 *
 * Pulled into its own (non-"use server") module, alongside maybeRecordPendingSpellDraw
 * and isStaleRoundError below, so admin/test-room/actions.ts's "roll for
 * others" actions (issue #102 follow-up) can share them too — a "use server"
 * file's exports must all be async actions themselves, so these plain
 * helpers can't live in rounds/actions.ts and be exported from there.
 */
export function revalidateRoundSurfaces() {
  revalidatePath("/");
  revalidatePath("/admin/test-room");
}

/**
 * Records a pending spell draw if the just-submitted value is a natural 1
 * or 20 (issue #66) — scoped here, at the main round roll's submission, so
 * a card's own resolution roll (e.g. a future counterspell DC check) never
 * triggers a draw (user story 32). Used to draw immediately; now just
 * records the trigger (supabase/migrations/0036_manual_spell_card_draw.sql)
 * so the roller can be offered a choice — draw in-app, or "I drew this
 * IRL" against the physical deck — before the card actually gets drawn
 * (SpellDrawChoicePanel.tsx).
 */
export async function maybeRecordPendingSpellDraw(
  supabase: Awaited<ReturnType<typeof createClient>>,
  value: number,
  roundId: string,
) {
  if (value === 1) await recordPendingSpellDraw(supabase, roundId, "nat1");
  else if (value === 20) await recordPendingSpellDraw(supabase, roundId, "nat20");
}

/**
 * The admin "roll for others" counterpart to maybeRecordPendingSpellDraw —
 * draws immediately rather than deferring to a pending-choice prompt (Test
 * Room admin puppeting has no physical deck to defer to), for
 * the explicit target player rather than current_player_id()'s Acting As
 * resolution (submit_roll_as/submit_manual_roll_as, 0029, already take that
 * target explicitly — this closes the same gap for the draw that follows),
 * and optionally forces a specific card (issue: "pick which cards are drawn
 * on a crit") instead of the usual random in-deck instance. draw_spell_card_as
 * re-checks admin + Test Room server-side regardless of what's passed here.
 */
export async function maybeDrawSpellCardAs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  value: number,
  roomId: string,
  playerId: string,
  forcedCardId?: string,
) {
  if (value === 1) await drawSpellCardAs(supabase, "nat1", roomId, playerId, forcedCardId);
  else if (value === 20) await drawSpellCardAs(supabase, "nat20", roomId, playerId, forcedCardId);
}

/**
 * Re-enters layer resolution once a Pending Spell Die (issue #252) has just
 * been resolved — the counterpart to submitRollAction/submitManualRollAction's
 * own resolveCompletedLayerIfAny call, needed here because
 * get_current_layer_rolls_if_complete's new gate (0068) may have left the
 * round's layer-0 rolls "complete but blocked" the whole time this die was
 * outstanding. Which function re-drives it depends on whether a layer-0
 * reaction window already exists for this round:
 *  - none yet: a pre-roll cast (e.g. Cold Tea) — resolveCompletedLayerIfAny
 *    hasn't run its "layer complete" branch yet, so it still needs to (which
 *    may now open the window for the first time).
 *  - one already exists, open or closed-but-blocked: a reaction cast (e.g.
 *    Slipped Spoon) — the window itself already opened (and may already have
 *    closed via passes) while this die sat pending, so finalizeReactionWindow
 *    is the one that needs re-running, not resolveCompletedLayerIfAny (which
 *    would try to open a *second* window and collide with
 *    spell_reaction_windows_one_open_per_round).
 */
export async function afterPendingSpellDieResolved(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roundId: string,
) {
  const hasWindow = await hasLayerZeroReactionWindow(supabase, roundId);
  if (hasWindow) {
    await finalizeReactionWindow(supabase, roundId);
  } else {
    await resolveCompletedLayerIfAny(supabase, roundId);
  }
}

/**
 * True for the two submit_roll/submit_manual_roll rejections that mean "the
 * round moved on under you" rather than a real failure — the stall-timeout
 * checker (enforceStallTimeout, src/app/rounds/stallEnforcement.ts) runs
 * lazily on every render, so it can cancel a round or exclude this player
 * from the current layer between the page rendering the roll form and the
 * form actually being submitted. Surfacing that race as a crash (the prior
 * behaviour: throw straight through, no error boundary anywhere in
 * src/app) sent the stalled player to a raw error page for a state change
 * that was correct and expected; refreshing to the room's current state is
 * the right response instead.
 *
 * Keyed off the RFB01/RFB02 Postgres error codes (supabase/migrations/
 * 0013_stale_round_error_codes.sql), not the exception message text — a
 * cosmetic wording change to a `raise exception` string can't silently
 * break this check now. RFB03 (supabase/migrations/0019_spell_casts_pre_roll.sql)
 * extends the same convention to castSpellCardAction/setSpellCastTargetAction:
 * casting/targeting racing against declare-in closing is exactly the same
 * "round moved on under you" shape as a stale roll. RFB04
 * (supabase/migrations/0020_spell_reaction_window.sql) extends it again to
 * castReactionSpellCardAction/passReactionWindowAction: reacting or passing
 * against a window that's already closed (someone else's pass just closed
 * it) is the same race, one layer up. RFB05
 * (supabase/migrations/0023_declare_in_stale_round_error_code.sql) extends
 * it once more to declareInAction: declaring in against a round that
 * close_round already closed between render and submit is the same race,
 * one phase earlier than RFB01. submit_roll_as/submit_manual_roll_as
 * (0029_admin_roll_as.sql) reuse the same RFB01/RFB02 codes for the admin
 * "roll for others" actions, so this check covers them too. RFB31
 * (supabase/migrations/0068_declare_in_late.sql, issue #246) extends it
 * once more to declareInLateAction: a Late Declare racing against the
 * round's first roll landing is the same race, one phase later than RFB05.
 */
export function isStaleRoundError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "RFB01" ||
    code === "RFB02" ||
    code === "RFB03" ||
    code === "RFB04" ||
    code === "RFB05" ||
    code === "RFB31"
  );
}

/**
 * Shared result shape for the spell-cast form actions (issue #244):
 * cast_spell_card/cast_reaction_spell_card/set_spell_cast_target/
 * end_active_effect validate most of their preconditions with a plain
 * `raise exception` (target-shape rules, declared-number range, casting_time
 * mismatch, caster/target round-participant checks) rather than a dedicated
 * errcode — isStaleRoundError above already carves out the "round moved on
 * under you" family, so anything left over here is a real precondition
 * failure the caller did something to trigger, not a race. Mirrors
 * DrawPendingSpellCardManualState's shape so the panels/forms rendering
 * these can use the same useActionState + inline-error pattern
 * (SpellDrawChoicePanel.tsx) instead of letting the throw reach the root
 * error boundary (src/app/error.tsx).
 */
export type SpellCastActionState = { status: "idle" } | { status: "error"; message: string };

/**
 * Turns a non-stale precondition failure from one of the spell-cast RPCs
 * into a SpellCastActionState the calling action can return. Strips the
 * `function_name: ` prefix every `raise exception` in those RPCs uses
 * (e.g. "cast_spell_card: this card requires at least one chosen player")
 * so the message reads naturally inline near the cast controls, without
 * needing to special-case each RPC's exception text individually.
 */
export function spellCastActionError(error: unknown): { status: "error"; message: string } {
  const message = (error as { message?: string } | null)?.message;
  return {
    status: "error",
    message: message ? message.replace(/^[a-z_]+: /, "") : "Something went wrong casting that card — try again.",
  };
}

/**
 * The full catch-block behavior shared by castSpellCardAction,
 * setSpellCastTargetAction, endActiveEffectAction, and
 * castReactionSpellCardAction: a stale-round race still revalidates
 * silently and reports "idle" (matching every other action's stale-round
 * handling above), while anything else becomes the inline typed error via
 * spellCastActionError. Pulled out once these four actions all needed the
 * exact same two-branch shape, rather than repeating it at each call site.
 */
export function resolveSpellCastError(error: unknown): SpellCastActionState {
  if (isStaleRoundError(error)) {
    revalidateRoundSurfaces();
    return { status: "idle" };
  }
  return spellCastActionError(error);
}
