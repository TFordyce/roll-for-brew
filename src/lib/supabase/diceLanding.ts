import { cookies } from "next/headers";

// Whether the viewer's own die waits for the shared reveal instead of landing
// as soon as their value arrives.
//
// A viewing preference, not a player setting: per-browser and cookie-backed,
// mirroring Admin Mode. It never touches `player_settings`, the room view DTO,
// or the database — the default (no cookie) is the early landing.
const HOLD_OWN_DIE_COOKIE = "dice_hold_own_die";

export async function getHoldOwnDieUntilReveal(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore.get(HOLD_OWN_DIE_COOKIE)?.value === "true";
}

export async function setHoldOwnDieUntilReveal(enabled: boolean): Promise<void> {
  const cookieStore = await cookies();
  if (enabled) {
    cookieStore.set(HOLD_OWN_DIE_COOKIE, "true", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  } else {
    cookieStore.delete(HOLD_OWN_DIE_COOKIE);
  }
}
