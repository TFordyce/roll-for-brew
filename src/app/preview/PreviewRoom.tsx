"use client";

import { useState } from "react";
import { CardFrame } from "@/app/_components/CardFrame";
import { ParallaxBackdrop } from "@/app/_components/ParallaxBackdrop";
import { PlayerTile } from "@/app/_components/PlayerTile";

const MOCK_ROSTER = [
  { displayName: "Alex", email: "alex@example.com", avatarUrl: null, modifier: 2 },
  { displayName: "Sam", email: "sam@example.com", avatarUrl: null, modifier: -1 },
];

/** Toggles the "Room" card between empty and a mock roster — no Supabase, no auth. */
export function PreviewRoom() {
  const [populated, setPopulated] = useState(false);

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center gap-6 bg-tavern-plank p-8">
      <ParallaxBackdrop playerId="preview" />

      <h1 className="font-display text-2xl font-semibold uppercase tracking-widest text-gilt-bright">
        Roll for Brew
      </h1>
      <div className="rounded-md bg-parchment/90 px-4 py-2 font-display text-xs uppercase tracking-widest text-tavern-panel">
        Preview — local only, no login
      </div>

      <section className="w-full max-w-md">
        <CardFrame title="The Room">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
            {populated ? (
              MOCK_ROSTER.map((entry) => <PlayerTile key={entry.email} {...entry} />)
            ) : (
              <p className="col-span-full text-sm text-parchment-dim">No one's here yet.</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setPopulated((prev) => !prev)}
            className="mt-4 w-full rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-sm uppercase tracking-widest text-parchment hover:bg-ember-bright"
          >
            {populated ? "Clear Room" : "Add Mock Players"}
          </button>
        </CardFrame>
      </section>
    </main>
  );
}
