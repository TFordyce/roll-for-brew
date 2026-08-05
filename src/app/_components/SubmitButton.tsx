"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes } from "react";

/**
 * Submit button for `<form action={fn}>` forms (issue #169) — reads pending
 * state from the nearest enclosing form via useFormStatus, so plain
 * fire-and-forget server actions (declareInAction, startRoundAction, etc.)
 * don't need to be converted to useActionState just to get a loading
 * indicator. Disables while pending and shows a spinner beside the
 * unchanged label; relies on the root error boundary (src/app/error.tsx) to
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
    <button type="submit" disabled={disabled || pending} className={className} {...props}>
      <span className="inline-flex items-center justify-center gap-2">
        {pending ? (
          <svg className="h-4 w-4 animate-spin text-gilt-bright" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : null}
        {children}
      </span>
    </button>
  );
}
