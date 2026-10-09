import { describe, expect, it, vi } from "vitest";
import { createRoomViewStore, type RoomView } from "./roomViewStore";

function view(version: number, marker = `v${version}`): RoomView {
  return { version, room: { roomId: "room-1", marker }, viewer: { playerId: "p1" } } as unknown as RoomView;
}

/** A fetchView whose every call is a promise the test settles by hand, in any order. */
function manualFetch() {
  const pending: { resolve: (v: RoomView) => void; reject: (e: unknown) => void }[] = [];
  const fetchView = vi.fn(
    () =>
      new Promise<RoomView>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { fetchView, pending };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createRoomViewStore", () => {
  it("starts on the server-rendered initial view", () => {
    const { fetchView } = manualFetch();
    const store = createRoomViewStore({ initialView: view(1), fetchView });
    expect(store.getSnapshot()).toEqual(view(1));
  });

  it("applies a refetched view and notifies subscribers", async () => {
    const { fetchView, pending } = manualFetch();
    const store = createRoomViewStore({ initialView: view(1), fetchView });
    const listener = vi.fn();
    store.subscribe(listener);

    store.refetch();
    pending[0]!.resolve(view(2));
    await flush();

    expect(store.getSnapshot()).toEqual(view(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe("coalescing", () => {
    it("starts a fetch immediately when idle", () => {
      const { fetchView } = manualFetch();
      const store = createRoomViewStore({ initialView: view(1), fetchView });
      store.refetch();
      expect(fetchView).toHaveBeenCalledTimes(1);
    });

    it("folds any number of refetches during a fetch into one follow-up", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(1), fetchView });

      store.refetch();
      store.refetch();
      store.refetch();
      store.refetch();
      expect(fetchView).toHaveBeenCalledTimes(1);

      pending[0]!.resolve(view(2));
      await flush();
      expect(fetchView).toHaveBeenCalledTimes(2);

      pending[1]!.resolve(view(3));
      await flush();
      expect(fetchView).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot()).toEqual(view(3));
    });

    it("does not follow up when nothing asked during the fetch", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(1), fetchView });

      store.refetch();
      pending[0]!.resolve(view(2));
      await flush();

      expect(fetchView).toHaveBeenCalledTimes(1);
    });

    it("keeps the current view on a failed fetch, reports it, and still runs the queued follow-up", async () => {
      const { fetchView, pending } = manualFetch();
      const onError = vi.fn();
      const store = createRoomViewStore({ initialView: view(1), fetchView, onError });

      store.refetch();
      store.refetch();
      pending[0]!.reject(new Error("boom"));
      await flush();

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
      expect(store.getSnapshot()).toEqual(view(1));
      expect(fetchView).toHaveBeenCalledTimes(2);

      pending[1]!.resolve(view(2));
      await flush();
      expect(store.getSnapshot()).toEqual(view(2));
    });

    it("can fetch again after a failure with nothing queued", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(1), fetchView, onError: () => {} });

      store.refetch();
      pending[0]!.reject(new Error("boom"));
      await flush();
      store.refetch();

      expect(fetchView).toHaveBeenCalledTimes(2);
    });
  });

  describe("ordering", () => {
    // Two requests in flight at once: the coalescing rules never allow this from refetch(), so the
    // older one is a stale response arriving after a newer one only via the server-seed path.
    it("drops a response from an older request that lands after a newer one was applied", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(1), fetchView });

      store.refetch(); // request A
      store.applyServerView(view(3)); // newer sequence: a server render that finished after A started
      pending[0]!.resolve(view(5)); // A's response arrives late
      await flush();

      expect(store.getSnapshot()).toEqual(view(3));
    });

    it("drops a response whose version is lower than the one already held", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(4), fetchView });

      store.refetch();
      pending[0]!.resolve(view(3));
      await flush();

      expect(store.getSnapshot()).toEqual(view(4));
    });

    it("applies a response at the same version (derived fields such as the stall deadline can move without a bump)", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(4, "old"), fetchView });

      store.refetch();
      pending[0]!.resolve(view(4, "new"));
      await flush();

      expect(store.getSnapshot()).toEqual(view(4, "new"));
    });

    it("compares versions numerically when the API sends the int64 as a string", async () => {
      const { fetchView, pending } = manualFetch();
      const store = createRoomViewStore({ initialView: view(9), fetchView });

      store.refetch();
      pending[0]!.resolve({ ...view(0), version: "10" } as unknown as RoomView);
      await flush();

      expect(store.getSnapshot().version).toBe("10");
    });
  });
});
