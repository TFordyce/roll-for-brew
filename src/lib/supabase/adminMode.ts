import { cookies } from "next/headers";

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
