export function canAccessTestRoom({
  isAdmin,
  adminModeEnabled,
}: {
  isAdmin: boolean;
  adminModeEnabled: boolean;
}): boolean {
  return isAdmin && adminModeEnabled;
}
