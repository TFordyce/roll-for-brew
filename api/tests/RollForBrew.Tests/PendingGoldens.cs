namespace RollForBrew.Tests;

/// <summary>
/// Golden scenarios Evaluate cannot reproduce yet, by name. Delete a line when its phase lands (the harness fails
/// if a listed scenario starts matching). Goal: empty. Owners: #543 phases 3-4c, #544 phase 05 tea-maker ladder,
/// #545 phases 5-6, wild scenarios and Commit. Entries are grouped under the FIRST unported phase the
/// scenario reaches (the owning ticket can differ from the filename prefix; reassign freely).
/// </summary>
internal static class PendingGoldens
{
    public static readonly IReadOnlySet<string> Names = new HashSet<string>(StringComparer.Ordinal)
    {
        // first unported phase: 3-pre
        "3-calami-tea-floored-natural-1",
        "3-pre-calami-tea-tick-warded",
        // first unported phase: 4c
        "4c-lowest-gains-highest-modifier",
        "4c-targeting-skip-excludes-holder",
        // first unported phase: 4b-pre
        "4b-pre-bitter-leech-tick-synthesis",
        // first unported phase: 4b
        "4b-persistent-modifier-transfer-rest-of-day",
        "wild-2-persistent-plus-three-caster",
        "wild-3-modifier-swap-pair",
        "wild-5-high-low-modifier-swap-pair",
        // first unported phase: 5
        "05-brew-debt-round-paid",
        "05-brew-iou-creates-debt",
        "05-brewer-immunity-all-immune-tie",
        "05-brewer-immunity-declared-number",
        "05-brewer-immunity-lowest-roller",
        "05-brewer-immunity-override-falls-through",
        "05-declared-number-tea-maker",
        "05-earl-declared-number-no-transfer",
        "05-earl-lowest-roller-next-lowest-brews",
        "05-earl-override-transfers-title",
        "05-loaf-of-lipton-skips-roll",
        "05-loose-leaf-holder-alone-second",
        "05-loose-leaf-named-by-override",
        "05-loose-leaf-rolloff",
        "05-loose-leaf-tied-second",
        "05-loose-leaf-two-player-inert",
        "05-pg-tipped-compares-post-shim-rolls",
        "05-pg-tipped-condition-met",
        "05-pg-tipped-condition-not-met",
        "05-pg-tipped-not-met-earlier-override-stands",
        "05-pg-tipped-redirected-onto-caster",
        "05-tea-cosy-exempt-and-immune",
        "05-tea-maker-override-highest-modifier-no-gain",
        "05-tea-maker-override-highest-roll",
        "05-tea-maker-override-prev-round-highest",
        "05-tea-maker-override-prev-round-highest-falls-through",
        "05-tea-maker-override-prev-round-highest-inert",
        "05-tea-party-revolt-abandoned-earlier-override-stands",
        "05-tea-party-revolt-pick-abandoned",
        "05-tea-party-revolt-picked",
        "wild-6-tea-maker-override-chosen",
        // first unported phase: 6
        "6-heist-countered",
        "6-heist-fizzled-victim-played-first",
        "6-heist-moved",
        "6-marked-for-brew-fizzled",
        "6-marked-for-brew-placed",
        "6-marked-for-brew-redirected",
        "6-stale-biscuit-placed",
    };
}
