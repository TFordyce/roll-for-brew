/**
 * The single source of truth for "can this caller reach the Test Room right
 * now" (issue #101) — shared by the /admin/test-room route guard and the
 * username-badge menu's visibility check, so the two can never disagree.
 * Both flags are required: `isAdmin` (players.is_admin, migration-only) and
 * `adminModeEnabled` (the per-browser Admin Mode cookie) each gate
 * independently, so neither alone is enough.
 */
export function canAccessTestRoom({
  isAdmin,
  adminModeEnabled,
}: {
  isAdmin: boolean;
  adminModeEnabled: boolean;
}): boolean {
  return isAdmin && adminModeEnabled;
}
