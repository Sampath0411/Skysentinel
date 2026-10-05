/**
 * Structured report form (PRD §5.3 FR-DEC-3).
 *
 * The `R` hotkey has to bring the form into view as well as focus it, and `send`
 * is the boundary where a half-empty form must be refused client-side rather than
 * shipped to the server for a 400.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { FusedTrack } from "@skysentinel/sim-core";

import ReportForm from "./ReportForm.js";

const track = (track_id: string, bearing_deg: number, range_m?: number): FusedTrack =>
  ({ track_id, bearing_deg, range_m, status: "confirmed", conf: 0.9, sources: ["radar"] }) as unknown as FusedTrack;

const baseProps = {
  tracks: [] as FusedTrack[],
  selectedTrack: null,
  reportLoc: null,
  focusSignal: 0,
  events: [],
  onSubmit: () => undefined,
};

describe("ReportForm", () => {
  it("refuses to send a form with nothing in it", () => {
    // The server requires a track, an activity or a description. Sending anyway
    // would burn a radio slot and come back as an error the trainee cannot undo.
    const onSubmit = vi.fn();
    render(<ReportForm {...baseProps} onSubmit={onSubmit} />);

    screen.getByRole("button", { name: /Send report/i }).click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends only the fields that were filled", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<ReportForm {...baseProps} onSubmit={onSubmit} />);

    await user.type(screen.getByPlaceholderText("e.g. orbiting near fuel point"), "orbiting");
    await user.click(screen.getByRole("button", { name: /Send report/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ activity: "orbiting", confidence: "medium" }),
    );
    // An untouched field must not arrive as an empty string the server stores.
    expect(Object.keys(onSubmit.mock.calls[0]![0])).not.toContain("quantity");
  });

  it("fills the position fields when a track is selected", () => {
    render(<ReportForm {...baseProps} tracks={[track("T1", 42, 300)]} selectedTrack="T1" />);

    expect(screen.getByPlaceholderText("from observer, 0=N")).toHaveValue("42");
    expect(screen.getByPlaceholderText("metres")).toHaveValue("300");
  });

  it("leaves range empty when the track has no range fix", () => {
    // A track with `range_m: undefined` is "bearing only"; writing "undefined"
    // into the field would be sent as NaN metres.
    render(<ReportForm {...baseProps} tracks={[track("T1", 42)]} selectedTrack="T1" />);
    expect(screen.getByPlaceholderText("metres")).toHaveValue("");
  });

  it("focuses and scrolls the form when the R hotkey fires", () => {
    // `R` is documented as opening the report; a focus on a field below the fold
    // the trainee cannot see is not an open.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(<ReportForm {...baseProps} focusSignal={0} />);

    rerender(<ReportForm {...baseProps} focusSignal={1} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.getByPlaceholderText("e.g. orbiting near fuel point")).toHaveFocus();
  });

  it("clears the description after a send", async () => {
    const user = userEvent.setup();
    render(<ReportForm {...baseProps} onSubmit={vi.fn()} />);

    const desc = screen.getByPlaceholderText("e.g. multirotor, ~1 m, white");
    await user.type(desc, "quadcopter");
    await user.click(screen.getByRole("button", { name: /Send report/i }));

    expect(desc).toHaveValue("");
  });
});
