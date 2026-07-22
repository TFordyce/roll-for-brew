import type { ReactNode } from "react";

/**
 * Gold-bordered, dark-filled panel wrapper — the tabletop design system's
 * base UI chrome (issue #64), modelled on a TCG card's engraved frame.
 * Reused for both pre-roll lobby states now, and intended for Stats/
 * Settings/roll-reveal screens in later passes.
 */
export function CardFrame({
  title,
  children,
  className = "",
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border-4 border-gilt bg-tavern-panel p-4 shadow-[0_0_0_1px_theme(colors.gilt.dark),0_8px_24px_rgb(0_0_0_/_0.5)] ${className}`}
    >
      {title ? (
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-widest text-gilt-bright">
          {title}
        </h2>
      ) : null}
      {children}
    </div>
  );
}
