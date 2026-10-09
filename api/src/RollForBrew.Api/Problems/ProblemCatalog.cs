namespace RollForBrew.Api.Problems;

public enum ProblemClass
{
    State = 409,
    Rule = 422,
    Input = 400,
    Auth = 403,
    Missing = 404,
}

public sealed record ProblemInfo(string SqlState, string Code, ProblemClass Class, string Title);

public static class ProblemCatalog
{
    private static readonly ProblemInfo[] Rows =
    [
        new("RFB01", "round_not_open_for_rolling", ProblemClass.State, "The round is not open for rolling."),
        new("RFB02", "not_expected_roller", ProblemClass.State, "You are not expected to roll in the current layer."),
        new("RFB03", "round_not_open_for_casting", ProblemClass.State, "The round is not open for casting."),
        new("RFB04", "no_open_reaction_window", ProblemClass.State, "There is no open reaction window for this round."),
        new("RFB05", "round_not_open_for_declarations", ProblemClass.State, "The round is not open for declarations."),
        new("RFB06", "card_not_in_deck", ProblemClass.State, "That card is not currently in the deck."),
        new("RFB07", "card_already_held", ProblemClass.State, "That card is already held by someone."),
        new("RFB08", "player_already_holds_card", ProblemClass.State, "That player already holds a card."),
        new("RFB09", "card_not_assigned", ProblemClass.State, "That card is not assigned to anyone."),
        new("RFB10", "adjustment_delta_zero", ProblemClass.Input, "The adjustment must be non-zero."),
        new("RFB11", "adjustment_reason_required", ProblemClass.Input, "A reason is required."),
        new("RFB12", "adjustment_target_not_in_room", ProblemClass.Rule, "The target is not in today's room."),
        new("RFB13", "adjustment_not_actor", ProblemClass.Auth, "Only the actor can undo their own adjustment."),
        new("RFB14", "adjustment_not_most_recent", ProblemClass.Rule, "Only the most recent adjustment can be undone."),
        new("RFB15", "adjustment_undo_window_passed", ProblemClass.State, "The undo window has passed."),
        new("RFB16", "admin_required_delete_round", ProblemClass.Auth, "Only an admin can delete a round."),
        new("RFB17", "delete_round_reason_required", ProblemClass.Input, "A reason is required."),
        new("RFB18", "round_not_found", ProblemClass.Missing, "Round not found."),
        new("RFB19", "admin_required_delete_adjustment", ProblemClass.Auth, "Only an admin can delete an adjustment."),
        new("RFB20", "delete_adjustment_reason_required", ProblemClass.Input, "A reason is required."),
        new("RFB21", "adjustment_not_found", ProblemClass.Missing, "Adjustment not found."),
        new("RFB22", "brew_rating_score_out_of_range", ProblemClass.Input, "The score must be between 1 and 5."),
        new("RFB23", "brew_rating_round_not_rateable", ProblemClass.Missing, "Round not found or not resolved."),
        new("RFB24", "brew_rating_not_participant", ProblemClass.Auth, "You did not participate in this round."),
        new("RFB25", "brew_rating_self", ProblemClass.Rule, "The brewer cannot rate themself."),
        new("RFB26", "brew_rating_not_most_recent", ProblemClass.Rule, "Only your most recent non-brewer round can be rated."),
        new("RFB27", "brew_rating_window_closed", ProblemClass.State, "The rating window has closed."),
        new("RFB28", "order_drink_type_invalid", ProblemClass.Input, "The drink type must be tea or coffee."),
        new("RFB29", "order_round_not_open", ProblemClass.State, "The round is not open for ordering."),
        new("RFB30", "order_window_closed", ProblemClass.State, "The order window has closed."),
        new("RFB31", "round_closed_for_late_declare", ProblemClass.State, "The round is no longer open for a late declare."),
        new("RFB32", "round_closed_for_proxy_roll", ProblemClass.State, "The round is no longer open for a proxy roll."),
        new("RFB33", "admin_required_backfill", ProblemClass.Auth, "Only an admin can backfill a round."),
        new("RFB34", "backfill_too_few_participants", ProblemClass.Input, "At least 2 participants are required."),
        new("RFB35", "backfill_no_layers", ProblemClass.Input, "At least one layer of rolls is required."),
        new("RFB36", "backfill_round_in_progress", ProblemClass.State, "Another round is already in progress in today's room."),
        new("RFB37", "backfill_layer_roster_mismatch", ProblemClass.Input, "A layer roster or a roll is missing."),
        new("RFB38", "backfill_roll_out_of_range", ProblemClass.Input, "A roll must be between 1 and 20."),
        new("RFB39", "backfill_extra_layer", ProblemClass.Input, "The round already resolved; no further layers are expected."),
        new("RFB40", "backfill_layer_still_tied", ProblemClass.Input, "The layer is still tied; a further layer is required."),
        new("RFB41", "card_rating_score_out_of_range", ProblemClass.Input, "The score must be between 1 and 5."),
        new("RFB42", "card_not_found", ProblemClass.Missing, "Card not found."),
        new("RFB43", "card_rating_no_eligible_cast", ProblemClass.Auth, "You have no eligible cast of this card."),
        new("RFB44", "no_modifier_to_spend", ProblemClass.Rule, "The caster has no modifier to spend."),
        new("RFB45", "spend_amount_required", ProblemClass.Input, "A spend amount is required."),
        new("RFB46", "invalid_cast_target", ProblemClass.Rule, "That is not a valid cast target."),
        new("RFB47", "replay_decision_state", ProblemClass.State, "The replay decision state does not allow this."),
        new("RFB48", "replay_not_caster", ProblemClass.Auth, "Only the caster can keep or scrap the round."),
        new("RFB49", "invalid_invocation", ProblemClass.Rule, "That is not a valid invocation."),
        new("RFB50", "cast_choice_required", ProblemClass.Rule, "A cast choice is required."),
        new("RFB51", "skip_vote_too_early", ProblemClass.State, "Voting has not opened yet."),
        new("RFB52", "skip_vote_not_allowed", ProblemClass.Auth, "You cannot vote to skip."),
        new("RFB53", "heist_target_empty_hand", ProblemClass.Rule, "That player is not holding a card to steal."),
        new("RFB54", "rolling_held_for_compelled_casts", ProblemClass.State, "Rolling is held until every compelled cast is in."),
        new("RFB55", "compelled_cast_required", ProblemClass.Rule, "A compelled cast must be made now."),
        new("RFB56", "no_courage_token_play", ProblemClass.Rule, "There is no Courage Token play available."),
        new("RFB57", "stale_biscuit_choice_required", ProblemClass.State, "The target has a live Stale Biscuit mark; choose where the card lands."),
        new("RFB58", "stale_biscuit_mark_gone", ProblemClass.State, "The Stale Biscuit mark is no longer live."),
    ];

    private static readonly Dictionary<string, ProblemInfo> BySqlState = Rows.ToDictionary(r => r.SqlState);

    public static IReadOnlyList<ProblemInfo> All => Rows;

    public static ProblemInfo? FromSqlState(string? sqlState) =>
        sqlState is not null && BySqlState.TryGetValue(sqlState, out var p) ? p : null;
}
