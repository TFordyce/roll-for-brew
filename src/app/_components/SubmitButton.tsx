"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes } from "react";

/**
 * Submit button for `<form action={fn}>` forms (issue #169) — reads pending
 * state from the nearest enclosing form via useFormStatus, so plain
 * fire-and-forget server actions (declareInAction, startRoundAction, etc.)
 * don't need to be converted to useActionState just to get a loading
 * indicator. Disables while pending and shows a teaspoon-stirring-in-a-cup
 * animation beside the unchanged label (issue #171); relies on the root
 * error boundary (src/app/error.tsx) to
 * catch thrown action errors, so there's no local pending-reset-on-error
 * logic here.
 *
 * Not used for forms that already manage their own pending state via
 * useActionState (CardAssignmentRow, SettingsForm, the manual spell-draw
 * form in SpellDrawChoicePanel) — those need the action's result, not just
 * its pending flag.
 */
export function SubmitButton({
  children,
  className,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();

  return (
    <button {...props} type="submit" disabled={disabled || pending} className={className}>
      <span className="inline-flex items-center justify-center gap-2">
        {pending ? (
          <svg className="h-4 w-4 text-gilt-bright" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {/* cup */}
            <path
              d="M4 9a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6V9Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            {/* handle */}
            <path
              d="M18 10.5h1a2.5 2.5 0 0 1 0 5h-1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            {/* teaspoon, rocking around the rim to mimic stirring */}
            <g className="origin-[11px_8px] animate-teaspoon-stir text-ember-bright motion-reduce:animate-none">
              <line x1="11" y1="8" x2="11" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="11" cy="15.5" r="1.3" fill="currentColor" />
            </g>
          </svg>
        ) : null}
        {children}
      </span>
    </button>
  );
}
