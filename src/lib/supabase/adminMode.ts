import { cookies } from "next/headers";

/**
 * Admin Mode (issue #101): a per-browser toggle, cookie-backed rather than a
 * DB column, so enabling/disabling it never writes to the database (see
 * CONTEXT.md). It only ever widens what a flagged `players.is_admin` caller
 * can reach — see canAccessTestRoom (src/lib/game/testRoomAccess.ts), the
 * one place both flags are combined.
 */
const ADMIN_MODE_COOKIE = "admin_mode";

export async function getAdminModeEnabled(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_MODE_COOKIE)?.value === "true";
}

export async function setAdminModeEnabled(enabled: boolean): Promise<void> {
  const cookieStore = await cookies();
  if (enabled) {
    cookieStore.set(ADMIN_MODE_COOKIE, "true", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    cookieStore.delete(ADMIN_MODE_COOKIE);
  }
}
