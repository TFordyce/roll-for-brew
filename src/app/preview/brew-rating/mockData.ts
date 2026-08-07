// PROTOTYPE — throwaway mock data standing in for the real "most recent
// rateable round" lookup. Only one round is ever rateable at a time (no
// queue, no backfill) — that's why this is a single object, not a list.

export type PanelState = "none" | "pending" | "rated";

export const MOCK_ROUND = {
  brewerName: "Sam",
  roomLabel: "Today's Room",
  resolvedAgo: "12 minutes ago",
};

export const MOCK_SUBMITTED_SCORE = 4;

export const PANEL_STATE_KEYS: PanelState[] = ["none", "pending", "rated"];

export const PANEL_STATE_LABEL: Record<PanelState, string> = {
  none: "Nothing to rate",
  pending: "Round to rate",
  rated: "Already rated",
};
