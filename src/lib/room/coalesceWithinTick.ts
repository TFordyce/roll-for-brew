export function coalesceWithinTick<T>(fn: (arg: T) => void): (arg: T) => void {
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
