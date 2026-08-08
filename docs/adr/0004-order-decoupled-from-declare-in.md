# Order decoupled from declare_in, editable through resolved

An Order (tea/coffee pick for a round) is a separate, optional action from `declare_in`, available once a round is `open` and independent of whether/when the player declares in. It stays editable all the way through `resolved`, closing only once the room's *next* round resolves — the same window `submit_brew_rating` already uses for the Rating Window.

`declare_in` is shared infrastructure — it's reused as-is for tie-break layers via `round_layer_participants` (`0004_round_lifecycle.sql`) — so bundling an unrelated, round-top-level-only concern into it would mean every layer-declare call site suddenly has to reason about tea/coffee. Keeping Order as its own action also matches the real-world shape of the feature: a player might declare in before deciding what they want to drink, or might set their Order before ever declaring, or might change their mind about the drink without that meaning anything about their declare status.

Editability through `resolved` (rather than closing at `open`→`closed`, like declare/withdraw do) is deliberate: the Menu's primary reader is the brewer, and the brewer only exists once the round is `resolved`. Locking Orders at `closed` would cut off exactly the phase where corrections matter most — someone glancing at the Menu post-roll and realizing they picked the wrong drink.

## Considered

- **Bundle Order into `declare_in`** (one action, order required to declare) — rejected: entangles a round-top-level-only concern with shared declare infrastructure used by tie-break layers too; also would make declaring in blocked on a tea/coffee decision, which the user's framing didn't ask for.
- **Lock Orders at `open`→`closed`** (same window as declare/withdraw) — rejected: the brewer — the Menu's main audience — isn't determined until `resolved`; locking earlier removes the ability to fix a wrong pick during the exact window it's being acted on.
- **No close at all** (editable forever) — rejected: would let a Menu on a room's ancient round keep changing indefinitely; reusing the Rating Window's "closes when the room's next round resolves" gives a natural, already-precedented cutoff.
