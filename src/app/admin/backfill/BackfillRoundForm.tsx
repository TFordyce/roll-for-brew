"use client";

import { useActionState, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { resolveLayer } from "@/lib/game/resolveLayer";
import { getTodaysModifiers, type BackfillLayer } from "@/lib/supabase/adminBackfill";
import { backfillRoundAction, type BackfillRoundState } from "./actions";
import type { RealPlayer } from "@/lib/supabase/players";

const initialState: BackfillRoundState = { status: "idle" };

type Step = "participants" | "layers";

/**
 * The /admin/backfill wizard (issue #274): walks an admin through entering
 * an entire missed round's rolls, one layer at a time, replaying
 * resolveLayer.ts (the exact same pure function the live app uses to decide
 * a tie vs. a brewer) client-side after every layer so the admin sees the
 * real outcome before confirming it — a tie reveals the next reroll layer's
 * roster automatically, and a single winner surfaces a final "Record this
 * round" step. The full layer-by-layer payload this wizard builds is only
 * ever sent once, on that final submit — admin_backfill_round (0071)
 * recomputes the same precedence server-side and rejects anything that
 * doesn't match, so this preview is a UX convenience, not the source of
 * truth.
 */
export function BackfillRoundForm({ players }: { players: RealPlayer[] }) {
  const [state, formAction, isPending] = useActionState(backfillRoundAction, initialState);

  const [step, setStep] = useState<Step>("participants");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modifiers, setModifiers] = useState<Record<string, number>>({});
  const [modifiersLoading, setModifiersLoading] = useState(false);

  const [completedLayers, setCompletedLayers] = useState<BackfillLayer[]>([]);
  const [currentRoster, setCurrentRoster] = useState<string[]>([]);
  const [currentValues, setCurrentValues] = useState<Record<string, string>>({});
  const [brewerId, setBrewerId] = useState<string | null>(null);

  const playersById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const nameFor = (id: string) => playersById.get(id)?.displayName ?? playersById.get(id)?.email ?? id;

  function toggleParticipant(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function startEnteringRolls() {
    setModifiersLoading(true);
    try {
      const supabase = createClient();
      const mods = await getTodaysModifiers(supabase, selectedIds);
      setModifiers(mods);
      setCompletedLayers([]);
      setCurrentRoster(selectedIds);
      setCurrentValues({});
      setBrewerId(null);
      setStep("layers");
    } finally {
      setModifiersLoading(false);
    }
  }

  function setValue(playerId: string, raw: string) {
    setCurrentValues((prev) => ({ ...prev, [playerId]: raw }));
  }

  const allEntered = currentRoster.every((id) => {
    const raw = currentValues[id];
    if (!raw) return false;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 20;
  });

  const preview =
    allEntered && currentRoster.length > 0
      ? resolveLayer(
          currentRoster.map((id) => ({
            playerId: id,
            roll: Number(currentValues[id]),
            modifier: modifiers[id] ?? 0,
          })),
        )
      : null;

  function confirmLayer() {
    if (!preview) return;
    const layer: BackfillLayer = currentRoster.map((id) => ({ playerId: id, value: Number(currentValues[id]) }));
    setCompletedLayers((prev) => [...prev, layer]);

    if (preview.outcome === "brewer") {
      setBrewerId(preview.playerId);
      setCurrentRoster([]);
    } else {
      setCurrentRoster(preview.tiedPlayerIds);
    }
    setCurrentValues({});
  }

  function resetAll() {
    setStep("participants");
    setSelectedIds([]);
    setModifiers({});
    setCompletedLayers([]);
    setCurrentRoster([]);
    setCurrentValues({});
    setBrewerId(null);
  }

  if (state.status === "success") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="font-body text-sm text-parchment">
          Round backfilled. Brewer: <span className="text-gilt-bright">{brewerId ? nameFor(brewerId) : "—"}</span>.
        </p>
        <button
          type="button"
          onClick={resetAll}
          className="rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment"
        >
          Backfill another round
        </button>
      </div>
    );
  }

  if (step === "participants") {
    return (
      <div className="flex flex-col gap-3">
        <p className="font-display text-xs uppercase tracking-widest text-parchment-dim">
          Who took part in this round?
        </p>
        <ul className="flex flex-col gap-1">
          {players.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 font-body text-sm text-parchment">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(p.id)}
                  onChange={() => toggleParticipant(p.id)}
                  className="h-4 w-4"
                />
                {p.displayName ?? p.email}
              </label>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={selectedIds.length < 2 || modifiersLoading}
          onClick={startEnteringRolls}
          className="mt-2 self-start rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim"
        >
          {modifiersLoading ? "Loading…" : "Enter rolls"}
        </button>
        {selectedIds.length === 1 ? (
          <p className="font-body text-xs text-red-500">At least 2 participants are required.</p>
        ) : null}
      </div>
    );
  }

  const layerIndex = completedLayers.length;
  const resolved = brewerId !== null;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="participantIds" value={JSON.stringify(selectedIds)} />
      <input type="hidden" name="layers" value={JSON.stringify(completedLayers)} />

      {!resolved ? (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-parchment-dim">
            {layerIndex === 0 ? "Layer 0 — everyone's roll" : `Reroll ${layerIndex} — tied roll-off`}
          </p>
          <ul className="flex flex-col gap-2">
            {currentRoster.map((id) => (
              <li key={id} className="flex items-center justify-between gap-3">
                <span className="font-body text-sm text-parchment">{nameFor(id)}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={currentValues[id] ?? ""}
                  onChange={(e) => setValue(id, e.target.value)}
                  className="w-20 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-2 py-1 text-right text-sm text-parchment focus:border-gilt focus:outline-none"
                />
              </li>
            ))}
          </ul>
          {preview ? (
            <p className="font-body text-xs text-parchment-dim">
              {preview.outcome === "brewer"
                ? `${nameFor(preview.playerId)} would be the brewer.`
                : `Tied: ${preview.tiedPlayerIds.map(nameFor).join(", ")} — reroll needed.`}
            </p>
          ) : null}
          <button
            type="button"
            disabled={!preview}
            onClick={confirmLayer}
            className="self-start rounded-md border-2 border-gilt-dark bg-transparent px-3 py-1 font-display text-xs uppercase tracking-widest text-parchment-dim hover:border-gilt hover:text-parchment disabled:cursor-not-allowed disabled:opacity-50"
          >
            {preview?.outcome === "tie" ? "Confirm layer, enter reroll" : "Confirm layer"}
          </button>
        </>
      ) : (
        <>
          <p className="font-body text-sm text-parchment">
            Brewer: <span className="text-gilt-bright">{nameFor(brewerId)}</span> — {selectedIds.length} cups, across{" "}
            {completedLayers.length} layer{completedLayers.length === 1 ? "" : "s"}.
          </p>
          <button
            type="submit"
            disabled={isPending}
            className="self-start rounded-md border-2 border-gilt bg-ember px-4 py-2 font-display text-xs uppercase tracking-widest text-parchment hover:bg-ember-bright disabled:cursor-not-allowed disabled:border-gilt-dark disabled:bg-tavern-panel-dark disabled:text-parchment-dim"
          >
            {isPending ? "Recording…" : "Record this round"}
          </button>
        </>
      )}

      {state.status === "error" ? (
        <p role="alert" className="font-body text-xs text-red-500">
          {state.message}
        </p>
      ) : null}

      <button
        type="button"
        onClick={resetAll}
        className="self-start font-body text-xs text-parchment-dim underline hover:text-parchment"
      >
        Start over
      </button>
    </form>
  );
}
