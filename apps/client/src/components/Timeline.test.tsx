/**
 * Decision timeline (PRD §12.2: "colour = verdict").
 *
 * The rule the AAR depends on is that a marker's colour agrees with the score
 * explanation beside it. The strip derives colour from the score tree's verdict
 * rather than from the event type, so a passed decision is green even if its type
 * colour is amber — and an event the tree never cites keeps its type colour,
 * because a sensor update has no verdict.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { AnySimEvent } from "@skysentinel/shared";

import Timeline from "./Timeline.js";

const ev = (
  seq: number,
  type: AnySimEvent["type"],
  t_ms: number,
  payload: Record<string, unknown> = {},
  // The payload union is strict; the fixtures only carry the fields the timeline
  // reads. The `type` stays checked, so a bogus event name is still a compile error.
): AnySimEvent => ({ seq, t_ms, type, actor: "trainee", visibility: "trainee", payload }) as AnySimEvent;

const PASS = "#57ab7a";
const FAIL = "#e5534b";

/** The marker for a seq, and the tooltip the AAR reader hovers for detail. */
const markerFor = (container: HTMLElement, seq: number): { g: Element; title: string } => {
  const g = container.querySelector(`[data-seq="${seq}"]`);
  if (g === null) throw new Error(`no marker for seq ${seq}`);
  return { g, title: g.querySelector("title")!.textContent! };
};

const renderTimeline = (
  events: AnySimEvent[],
  opts: { verdicts?: Map<number, "pass" | "fail">; criticalSeqs?: Set<number> } = {},
) =>
  render(
    <Timeline
      events={events}
      duration_ms={60_000}
      criticalSeqs={opts.criticalSeqs ?? new Set<number>()}
      verdicts={opts.verdicts}
      scrubT={0}
      onScrub={() => undefined}
    />,
  );

describe("Timeline", () => {
  it("renders a legend so the verdict colours mean something", () => {
    // PRD §12.2 colours by verdict; a coloured strip with no key is decoration.
    const { getByText } = renderTimeline([]);
    expect(getByText("Decision passed")).toBeInTheDocument();
    expect(getByText("Decision failed")).toBeInTheDocument();
    expect(getByText("Cue / sensor")).toBeInTheDocument();
  });

  it("colours a decision by its verdict, overriding the type colour", () => {
    // `authority_requested` is amber as a type; as a *failed* decision it must be
    // red, or the strip disagrees with the score panel beside it.
    const { container } = renderTimeline([ev(0, "authority_requested", 10_000, { track_id: "T1" })], {
      verdicts: new Map([[0, "fail"]]),
    });

    const { g, title } = markerFor(container, 0);
    expect(g.querySelector("polygon")!.getAttribute("fill")).toBe(FAIL);
    expect(title).toContain("(failed)");
  });

  it("renders a passed decision in green", () => {
    const { container } = renderTimeline(
      [ev(1, "classification_submitted", 20_000, { track_id: "T1" })],
      { verdicts: new Map([[1, "pass"]]) },
    );

    const { g, title } = markerFor(container, 1);
    expect(g.querySelector("polygon")!.getAttribute("fill")).toBe(PASS);
    expect(title).toContain("(passed)");
  });

  it("keeps the type colour for an event the score tree never cites", () => {
    // A sensor update has no verdict; colouring it pass/fail would be inventing a
    // judgement the score did not make.
    const { container } = renderTimeline([ev(2, "cue_presented", 30_000, { cue_id: "C1", sensor: "radar" })]);

    const { g, title } = markerFor(container, 2);
    expect(g.querySelector("circle")!.getAttribute("fill")).toBe("#3fb6d9");
    expect(title).not.toContain("passed");
    expect(title).not.toContain("failed");
  });

  it("rings and tags a marker linked to a critical error", () => {
    const { container } = renderTimeline(
      [ev(3, "impact", 40_000, { asset_id: "A1", damage: 0.8 })],
      { criticalSeqs: new Set([3]) },
    );

    const { g, title } = markerFor(container, 3);
    expect(g.querySelector("circle[stroke='#e5534b']")).not.toBeNull();
    expect(title).toContain("critical error");
  });

  it("reports the scrubbed time from the pointer position", () => {
    // The timeline drives the replay; a click must land on the sim time under the
    // pointer, not on the marker nearest it.
    const onScrub = vi.fn();
    // jsdom does no layout, so the host reports zero width and the component's
    // usable width would go negative. Give it a real width for this test only.
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { get: () => 900, configurable: true });
    try {
      const { container } = render(
        <Timeline events={[]} duration_ms={60_000} criticalSeqs={new Set()} scrubT={0} onScrub={onScrub} />,
      );
      const svg = container.querySelector("svg")!;
      const pad = 12;
      const rect = svg.getBoundingClientRect();

      svg.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: rect.left + pad + (900 - pad * 2) * 0.5,
          bubbles: true,
        }),
      );
    } finally {
      if (clientWidth !== undefined) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      }
    }

    expect(onScrub).toHaveBeenCalledTimes(1);
    // Mid-point of a 60 s strip over 900 px, ±50 ms for the sub-pixel placement.
    expect(onScrub.mock.calls[0]![0]).toBeCloseTo(30_000, -2);
  });
});
