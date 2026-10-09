import type { ReactNode } from "react";

export function SelectableOption({
  name,
  value,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: ReactNode;
  description: ReactNode;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border-2 border-gilt-dark bg-tavern-panel-dark px-3 py-2 text-sm text-parchment has-[:checked]:border-gilt-bright has-[:checked]:bg-ember/40">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="sr-only"
      />
      <span>
        <span className="block font-display uppercase tracking-wide text-gilt-bright">{label}</span>
        <span className="block text-parchment-dim">{description}</span>
      </span>
    </label>
  );
}
