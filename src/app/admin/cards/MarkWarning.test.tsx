import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkWarning } from "./MarkWarning";
import type { RealPlayer } from "@/lib/supabase/players";

const players = [
  { id: "p-target", displayName: "Tara", email: "tara@example.com" },
  { id: "p-marker", displayName: "Milo", email: "milo@example.com" },
] as RealPlayer[];

function render(beneficiaryId = "p-marker"): string {
  return renderToStaticMarkup(
    <MarkWarning
      cardId="c1"
      warning={{
        status: "mark_warning",
        playerId: "p-target",
        beneficiaryId,
        message: "That player has a live Stale Biscuit mark from Milo.",
      }}
      players={players}
      formAction={() => {}}
      isPending={false}
    />,
  );
}

function choiceButtons(html: string): string[] {
  return [...html.matchAll(/<button ([^>]*)>(.*?)<\/button>/g)]
    .filter((m) => m[1]!.includes('name="markChoice"'))
    .map((m) => `${m[1]!.match(/value="([^"]+)"/)![1]}: ${m[2]!.replaceAll("<!-- -->", "")}`);
}

describe("MarkWarning (issue #471)", () => {
  it("warns about the mark and offers the three choices, naming both players", () => {
    const html = render();
    expect(html).toContain("That player has a live Stale Biscuit mark from Milo.");
    expect(choiceButtons(html)).toEqual(["target: Give to Tara anyway", "beneficiary: Give to Milo", "cancel: Cancel"]);
  });

  it("re-submits the same card and target", () => {
    const html = render();
    expect(html).toContain('name="cardId" value="c1"');
    expect(html).toContain('name="playerId" value="p-target"');
  });

  it("falls back to 'the marker' when the beneficiary is not in the player list", () => {
    expect(choiceButtons(render("someone-else"))).toContain("beneficiary: Give to the marker");
  });
});
