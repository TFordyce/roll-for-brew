# Spell card transcription — verified against physical/photographed deck

Source: "Tea spells another draft.pdf" (Tom's photographed/exported card sheet, API All Stars 2026 print),
transcribed by viewing rendered card images directly (not OCR/text-layer extraction, which scrambles
name-to-effect pairing on this multi-column layout).

Resolves [Complete the full spell card transcription against the physical deck](https://github.com/TFordyce/roll-for-brew/issues/59),
a child ticket of [Roll for Brew: Spell Cards spec map](https://github.com/TFordyce/roll-for-brew/issues/51).

**Card key** (from the deck's own legend card):
- Tier · Target stamp: SELF (only you) · OPPONENT (one rival, never you) · PLAYER (anyone, incl. you) ·
  TABLE (the whole round) · CARD (another card or effect) · WILD (random or special)
- Top-right badge: **A** = Action · **R** = Reaction
- Every card carries "RETURN AFTER USE" — used cards go back to the deck (not permanently removed),
  consistent with the map's existing "deck is not permanently depleted" decision.

65 cards total: 20 Common, 33 Rare, 12 Epic.

## Common (20)

| Name | A/R | Target | Effect |
|---|---|---|---|
| Bes-Tea | A | Opponent | Copy another player's modifier for this round. |
| Six Sugars | R | Self | Add 1d6 to your roll this round. |
| Lucky Sip | A | Self | Add +3 to your roll this round. |
| Caffeinated Focus | A | Self | Add +5 to your roll this round. |
| Double Dunk | R | Self | Reroll your d20. Take the new result. |
| Milk First? | R | Opponent | Target rerolls their d20. They must take the new result. |
| Slipped Spoon | A | Opponent | Target rolls with disadvantage this round; you add 1d4 to your roll. |
| Cold Tea | A | Opponent | Target subtracts 3 from their roll this round; you add 1d4 to yours. |
| Sugar Rush | A | Self | Roll with advantage this round. |
| Brewer's Blessing | A | Player | Target player adds +5 to their roll this round. |
| Fortune's Flavour | A | Player | Target player rolls with advantage this round. |
| Tea Party Revolt | A | Table | The lowest roller chooses who makes tea this round. |
| Re-Steep | R | Self | Reroll your own d20. You must keep the new result. |
| Last Drip | A | Table | Force the winner of the previous round (highest roller) to make tea instead. They gain no modifier from this tea-making. |
| Tannin Tantrum | R | Card | Roll a d20 to cancel that card. Meet the DC for its tier — Common 2, Rare 5, Epic 10 — and its effect is cancelled entirely. Fail and it resolves as normal. |
| Saving Steep | R | Card | Roll a d20. On 10+, the card has no effect. On a nat 1, the effect is doubled against you. |
| Brew-tal Swap | R | Opponent | Swap your d20 result with another player's. |
| Yorkshire Terror | A | Opponent | Choose a target. After they roll, they must reroll and keep the new result. |
| Lesser Detox | A | Card | End an ongoing effect from a Common card on any player. |
| Cloud of Cream | A | Self | For the next 2 rounds your modifier is hidden; cards that target the highest or lowest modifier skip you and apply to the next player instead. |

## Rare (33)

| Name | A/R | Target | Effect |
|---|---|---|---|
| Tea Cosy | A | Self | You are exempt from rolling this round. You cannot be the tea-maker. |
| Boil Over | A | Table | All players' modifiers reset to 0 for this round only. |
| Milky Brew | A | Opponent | Target player's modifier is 0 for this round. |
| Double Shot | A | Self | Double your modifier for this round only. |
| Tea-M Reroll | R | Table | All players reroll their d20. New rolls determine the tea-maker. |
| Dunkin Disaster | R | Table | Force the highest and lowest rollers to swap their d20 results this round. |
| Broken Biscuit | R | Table | The lowest roller adds the highest modifier currently on the table to their roll this round. |
| Tea Leaf | A | Opponent | Steal a chosen player's entire current modifier. Their modifier drops to 0 and the full amount is added to yours for the rest of the day. |
| Spillage | A | Opponent | Halve a target's modifier, rounded down, for the rest of the day; add that removed amount to your roll next round. |
| Chai-nge of Heart | A | Opponent | Swap your modifier with a target's for the rest of the day. |
| Bag for Life | A | Self | Your modifier cannot be reduced, copied, or affected by any card for the rest of the day. You still gain modifier from making tea as normal. |
| Drip Tray | R | Table | Force the player with the highest current modifier to make tea instead. They gain no modifier from this tea-making. |
| Loose Leaf | R | Self | When you are named tea-maker, force a roll-off against the second-lowest roller. Both roll d20 — the loser makes tea instead. |
| Stir the Pot | A | Opponent | Choose two other players. They swap their d20 results this round. |
| PG Tipped | A | Opponent | Choose a target. If they roll lower than you this round, they make tea regardless of anyone else. If forced to make tea by this card, they gain no modifier from it. |
| Mug Shot | R | Opponent | Negate a target's modifier for this round only. |
| Jinxed Biscuit | A | Opponent | Curse a target. For the next 3 rounds, they cannot benefit from any buff card. |
| Marked for Brew | A | Opponent | Mark a target. Within the next 5 rounds they take part in, the first time they roll a nat 1 or nat 20, you draw the card instead. |
| Inscribed Saucer | A | Table | Declare a number 1–20 on play. The next player to roll that exact natural number makes tea, regardless of totals. |
| Mug Mirror | R | Card | That card's effect resolves on its caster instead of you. |
| Sleeping Camomile | A | Opponent | Target does not roll this round. Their result counts as a natural 1. If they make tea as a result, they gain no modifier from it. |
| Steaming Mug Bond | A | Opponent | Link to a target. This round, you both count as having rolled the lower of your two dice. If you are both tied at the lowest, roll off between yourselves to decide the tea-maker. |
| Tea-tally Spent | R | Self | Spend any amount of your modifier and add that much to this round's roll. Spent modifier is gone for the day. |
| Loaf of Lipton | A | Self | Skip your roll this round and make tea automatically. You gain double the usual modifier. |
| Brew IOU | A | Opponent | Choose a target. They make tea this round on your behalf, regardless of the dice. In return, you must make tea on the next round you would have rolled, no roll required. Both parties gain +N modifier from rounds they make. |
| Tea Heist | A | Opponent | Steal a card from another player's hand. They draw nothing in return. |
| Stale Biscuit | A | Opponent | Mark a target. The very next card they would draw goes to you instead. |
| Saucerer's Apprentice | R | Card | Copy that card's effect. The original effect still resolves; your copy resolves immediately afterwards. |
| Caffeine Crash | A | Opponent | Target's modifier is treated as −1 for the next 2 rounds. After 2 rounds, their modifier returns to its previous value. |
| Bitter Leech | A | Opponent | For the next 3 rounds, a target loses 1 modifier at the start of each round and you gain it. |
| Scalding Pour | A | Table | Every other player subtracts 3 from their roll this round. |
| Calami-Tea | A | Opponent | Choose up to 3 players. For the next 3 rounds, they each subtract 1d4 from their rolls. |
| Liquid Courage | A | Opponent | Give another player a d6. Once in the next 3 rounds, as a Reaction to any roll, they may roll it and add the result to that roll. |

## Epic (12)

| Name | A/R | Target | Effect |
|---|---|---|---|
| Kettle Crash | A | Table | All players' modifiers reset to 0. The day starts again, mechanically. |
| Wild Brew Surge | A | Wild | Roll a d6 and apply the matching effect: 1. All modifiers reset to 0. 2. You gain +3 modifier for the rest of the day. 3. Swap modifiers with a random player. 4. Everyone rerolls this round's d20. 5. Highest and lowest modifiers swap holders. 6. Choose who makes tea this round, regardless of the dice. |
| Time for Brew | R | Table | At the end of this round, after the tea-maker is announced, you may scrap the result. The round is replayed entirely — new rolls, new cards may be played. |
| Zariel's Fall | R | Table | Every d20 flips to its opposite face (21 minus current value): 1→20, 5→16, 19→2. Tea-maker is decided from the flipped values. Original rolls still trigger any nat 1 or nat 20 card draws. |
| Eternal Steep | A | Opponent | Choose a target. Their modifier is frozen at its current value. They gain no modifier from tea-making, and no card can alter their modifier. |
| The Last Cuppa | A | Self | You cannot be the tea-maker for the rest of the day under any circumstance. No card, force, mark, or curse can override this. |
| Earl of Earl Grey | A | Self | Take the title of Earl. While Earl, you cannot be tea-maker — the next-lowest roller makes tea instead. If a card would force tea on you, pass the title to its caster: they become Earl, you lose immunity. |
| Greater Detox | A | Card | End an ongoing Rare or Epic condition on any player. |
| Prophe-Tea | A | Self | For the rest of the day, you roll every round with advantage. |
| Topsy-Tea | A | Table | This round only, the highest roller makes tea instead of the lowest. |
| Genie in the Teapot | A | Card | Name any other non-Epic Action card in the deck and resolve its effect as if you had played it. |
| Kettle Storm | A | Table | Every other player subtracts 8 from their roll this round. |

## Reconciliation against the 9-card memory sample (issue #52)

| # | Memory card | Verdict | Real match |
|---|---|---|---|
| 1 | Milky Brew — Reaction, Opponent, "target rerolls and takes new result" | **Name collision.** A real card named *Milky Brew* exists but is a different card (Action, Rare, "target's modifier is 0 for this round"). Memory's *effect* actually belongs to **Milk First?** (Reaction, Common, Opponent — reroll, take new result). | Milk First? |
| 2 | Team Re-Roll — Reaction, all players (round), "all reroll and take new result" | **Close match**, name and mechanic both map cleanly to **Tea-M Reroll** (Reaction, Rare, Table); real card adds that the new rolls also decide the tea-maker, which memory omitted. | Tea-M Reroll |
| 3 | Two Sugars — Action, Self, "roll with advantage" | **Close match** on target/casting-time/effect; real name is **Sugar Rush**. A different card, *Six Sugars* (Reaction, Common, "add 1d6"), exists and is easy to confuse with the memory name. | Sugar Rush |
| 4 | Double Dunk — Action, Self, "double your modifier" | **Name collision.** A real card named *Double Dunk* exists but is Common/Reaction ("reroll your d20, take new result"). Memory's *effect* belongs to **Double Shot** (Action, Rare, "double your modifier this round only"). | Double Shot |
| 5 | Sugar Cubes — Action, Self, "add 1d6" | **Partial match.** Closest is **Six Sugars** (Reaction, not Action; "add 1d6 to your roll"). No card is named "Sugar Cubes." | Six Sugars |
| 6 | (unnamed) room-wide "modifiers to zero," day-long | **No exact match.** Two candidates split the described effect: **Boil Over** (Action, Rare, Table — modifiers to 0, but round-only, not day-long) and **Kettle Crash** (Action, Epic, Table — resets modifiers *and* restarts the day, i.e. bigger than "just zero the modifiers"). Neither card is a simple "zero modifiers for the rest of the day." | Boil Over / Kettle Crash (no clean single match) |
| 7 | (unnamed) counterspell — Reaction, negate a spell's effect, targets a spell being cast | **Mechanic corrected.** No card unconditionally negates. The deck's actual counterspell shape is a **roll-off against the caster's tier DC**: **Tannin Tantrum** (Common — roll d20 vs DC 2/5/10 by tier, success cancels entirely, fail resolves as normal) and **Saving Steep** (Common — roll d20, 10+ no effect, nat 1 doubles the effect against you). **Mug Mirror** (Rare) redirects a card's effect onto its caster rather than negating it. This resolves #55's flagged "may need revisiting" item on effect-mechanics methodology. | Tannin Tantrum / Saving Steep / Mug Mirror |
| 8 | Lesser Detox — Action, ends a lasting effect on any active effect | **Name matches**, scope corrected: real Lesser Detox only ends **Common**-tier ongoing effects. A separate **Greater Detox** (Epic) ends Rare/Epic conditions. Detox is tiered, not a single universal "end any effect" card. | Lesser Detox (Common-only) + Greater Detox (Rare/Epic) |
| 9 | Hex of the Broken Biscuit — Action, Opponent, "until the following Monday, subtract 1d4" | **No match — does not exist.** No card is named "Hex of the Broken Biscuit" or uses day-name-anchored durations (the deck's persistent effects always read "next N rounds" or "rest of the day," never a specific weekday). *Broken Biscuit* (Rare, Table) is an unrelated table-wide effect. Closest analog by mechanic (multi-target, persistent 1d4 roll subtraction) is **Calami-Tea** (Rare, Opponent — up to 3 players, next 3 rounds, each subtract 1d4). | No real equivalent; closest analog Calami-Tea |

**Net effect on the map:** 3 of 9 memory cards had a straightforward real match (Tea-M Reroll, Sugar Rush, Lesser Detox); 2 were **name collisions** where the remembered name belongs to a different real card (Milky Brew, Double Dunk); 1 was a same-effect/wrong-casting-time mismatch (Six Sugars); 1 had no single clean match, splitting across two cards (the modifiers-to-zero card); the counterspell mechanic itself was wrong (negate → roll-vs-DC contest); and one card doesn't exist in the real deck at all (Hex of the Broken Biscuit).
