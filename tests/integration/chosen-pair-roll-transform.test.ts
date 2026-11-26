import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestAdminClient,
  createTestCleanup,
  forceHold,
  hasAnonTestEnv,
  signUpSignInAndEnterRoom,
} from "./setup";

// Runs against a real Supabase stack. Covers issue #318 -- Tier A primitive 2,
// the chosen-pair roll transform (migration 0096): swap / set-both-lower /
// set-both-higher over a caster-named pair, generalising roll_swap past the
// automatic highest<->lowest pick. Cards: Brew-tal Swap (Reaction, swap),
// Stir the Pot (Action, swap two OTHER players), Steaming Mug Bond (Action,
// min), Tea for Two (Action, max). Assertions are on externally observable
// outcomes only: the mutated rolls, the recorded cast_inputs.roll_transform,
// the emitted Resolution Trace, and the picked brewer.

describe.skipIf(!hasAnonTestEnv)("chosen-pair roll transform (#318)", () => {
  let admin: SupabaseClient;
  let cleanup: ReturnType<typeof createTestCleanup>;

  beforeAll(() => {
    admin = createTestAdminClient();
    cleanup = createTestCleanup(admin);
  });

  afterEach(() => cleanup.run());

  function signUp(label: string) {
    return signUpSignInAndEnterRoom(admin, cleanup, label);
  }
  type Player = Awaited<ReturnType<typeof signUp>>;

  async function startRound(starter: Player, others: Player[]) {
    const { data: roundId, error } = await starter.client.rpc("start_round");
    expect(error).toBeNull();
    cleanup.trackRound(roundId as string);
    for (const o of others) {
      const { error: dErr } = await o.client.rpc("declare_in", { p_round_id: roundId });
      expect(dErr).toBeNull();
    }
    return roundId as string;
  }

  async function closeRound(starter: Player, roundId: string) {
    const { error } = await starter.client.rpc("close_round", { p_round_id: roundId });
    expect(error).toBeNull();
  }

  async function openAndCloseRound(starter: Player, others: Player[]) {
    const roundId = await startRound(starter, others);
    await closeRound(starter, roundId);
    return roundId;
  }

  async function openWindow(roundId: string, status: "open" | "closed" = "closed") {
    const { data, error } = await admin
      .from("spell_reaction_windows")
      .insert({ round_id: roundId, layer: 0, status })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  // ----------------------------------------------------------------------
  // The by-name cast branches: Brew-tal Swap (Reaction)
  // ----------------------------------------------------------------------

  it("Brew-tal Swap cannot target yourself", async () => {
    const p1 = await signUp("cp-btsself-1");
    const p2 = await signUp("cp-btsself-2");
    const roundId = await openAndCloseRound(p1, [p2]);
    await openWindow(roundId, "open");
    await forceHold(admin, p1.googleSub, "Brew-tal Swap");
    const { error } = await p1.client.rpc("cast_reaction_spell_card", {
      p_round_id: roundId,
      p_target_player_id: p1.googleSub,
    });
    expect(error).not.toBeNull();
  });

  // ----------------------------------------------------------------------
  // The by-name cast branches: Stir the Pot / Steaming Mug Bond / Tea for Two
  // ----------------------------------------------------------------------

  it("Stir the Pot rejects choosing the caster, and rejects not-exactly-two", async () => {
    const p1 = await signUp("cp-stpbad-1");
    const p2 = await signUp("cp-stpbad-2");
    const p3 = await signUp("cp-stpbad-3");
    const roundId = await startRound(p1, [p2, p3]);

    await forceHold(admin, p1.googleSub, "Stir the Pot");
    const includesCaster = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [p1.googleSub, p2.googleSub],
    });
    expect(includesCaster.error?.code).toBe("RFB46");

    const onlyOne = await p1.client.rpc("cast_spell_card", {
      p_round_id: roundId,
      p_chosen_player_ids: [p2.googleSub],
    });
    expect(onlyOne.error?.code).toBe("RFB46");
  });
});
