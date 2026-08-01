"use client";

import { setAdminModeAction } from "@/app/settings/actions";

/**
 * Admin Mode toggle (issue #101) — only ever rendered for a flagged
 * `players.is_admin` caller (see SettingsPage). Each click submits
 * immediately rather than needing a separate "Save", since it's a single
 * boolean cookie flip, not a form with several fields.
 */
export function AdminModeToggle({ enabled }: { enabled: boolean }) {
  return (
    <form action={setAdminModeAction}>
      <input type="hidden" name="adminMode" value={enabled ? "false" : "true"} />
      <button
        type="submit"
        className="w-full rounded-md border-2 border-gilt bg-tavern-panel-dark px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember/40"
      >
        Admin Mode: {enabled ? "On" : "Off"}
      </button>
    </form>
  );
}
