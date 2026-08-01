# Test Room modeled as a dateless room

`rooms.date` is `not null unique` — one row per calendar day is the entire mechanism `enter_todays_room()` relies on (`0003_rooms_and_room_players.sql:4-8`). The Test Room needs to be a real row in the same `rooms` table (so it reuses the real round/roll/resolution machinery) but isn't day-scoped at all — it's a single persistent fixture, not created fresh each day.

Rather than give it a placeholder date (e.g. a far-future sentinel), `rooms.date` is made nullable and the unique constraint becomes a partial index: `unique (date) where not is_test`. A Test Room genuinely has no date; a sentinel value would look like real data to any future date-based query or UI and invite confusion about why a room from decades in the future exists.

## Considered

- **Placeholder date** (e.g. `2099-01-01`) — rejected: satisfies the constraint with no schema change, but reads as real data to anything that doesn't know to special-case it.
