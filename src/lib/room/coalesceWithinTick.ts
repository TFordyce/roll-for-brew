/**
 * Wraps `fn` so calls made in the same tick run it once, on the next microtask, with the last
 * call's argument. Several panels hear one `room-changed` and each ask the legacy page for
 * `router.refresh()`; this folds them into a single refresh, as the room view store does for its
 * refetches.
 */
export function coalesceWithinTick<T>(fn: (arg: T) => void): (arg: T) => void {
  // Boxed so later calls in the tick can overwrite the argument the queued microtask will read.
  let pending: { arg: T } | null = null;
  return (arg) => {
    if (pending) {
      pending.arg = arg;
      return;
    }
    const call = (pending = { arg });
    queueMicrotask(() => {
      pending = null;
      fn(call.arg);
    });
  };
}
