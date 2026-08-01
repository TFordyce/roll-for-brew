import { describe, expect, it } from "vitest";
import { canAccessTestRoom } from "./testRoomAccess";

describe("canAccessTestRoom", () => {
  it("denies a non-admin with Admin Mode off", () => {
    expect(canAccessTestRoom({ isAdmin: false, adminModeEnabled: false })).toBe(false);
  });

  it("denies a non-admin with Admin Mode on (the cookie alone grants nothing)", () => {
    expect(canAccessTestRoom({ isAdmin: false, adminModeEnabled: true })).toBe(false);
  });

  it("denies an admin with Admin Mode off", () => {
    expect(canAccessTestRoom({ isAdmin: true, adminModeEnabled: false })).toBe(false);
  });

  it("allows an admin with Admin Mode on", () => {
    expect(canAccessTestRoom({ isAdmin: true, adminModeEnabled: true })).toBe(true);
  });
});
