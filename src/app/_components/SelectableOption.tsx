import type { ReactNode } from "react";

/**
 * Radio-backed selectable row for the tabletop design system (issue #64/#80)
 * — native input visually hidden (kept for a11y/form semantics), label
 * styled as a bordered tavern row that picks up a gilt-bright border and
 * ember tint when checked. Sibling to CardFrame for screens that need a
 * pick-one-of-several control (Settings' roll-input-mode today).
 */
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
