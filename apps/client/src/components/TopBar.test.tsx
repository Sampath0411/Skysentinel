/**
 * Top bar (PRD §13.1).
 *
 * The support-cue toggle is the one piece of stateful UI here, and the rule worth
 * pinning is that the button only exists once the run has presented a cue — a
 * toggle for zero cues is a control that changes nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import TopBar from "./TopBar.js";

const baseProps = {
  t_ms: 125_000,
  scenario: null,
  posture: null,
  sensorModes: {},
  supportCueCount: 0,
  supportCuesShown: false,
  onToggleSupportCues: () => undefined,
  onEnd: () => undefined,
};

describe("TopBar", () => {
  it("renders the scenario clock with tenths", () => {
    render(<TopBar {...baseProps} />);
    // 125 s → 02:05.0; a clock that reads 02:04.9 or 02:05 is rounding the other way.
    expect(screen.getByTitle(/Scenario clock/)).toHaveTextContent("02:05.0");
  });

  it("hides the support-cue toggle while no cue has been presented", () => {
    render(<TopBar {...baseProps} supportCueCount={0} />);
    expect(screen.queryByRole("button", { name: /cue/i })).not.toBeInTheDocument();
  });

  it("announces the cue count and toggles on click", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<TopBar {...baseProps} supportCueCount={3} onToggleSupportCues={onToggle} />);

    const button = screen.getByRole("button", { name: /Show 3 cues/i });
    expect(button).toBeInTheDocument();
    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reads Hide once the cues are shown", () => {
    render(<TopBar {...baseProps} supportCueCount={1} supportCuesShown />);
    // Singular too: "1 cue", never "1 cues".
    expect(screen.getByRole("button", { name: /Hide 1 cue$/ })).toBeInTheDocument();
  });

  it("reports each sensor's mode", () => {
    render(<TopBar {...baseProps} sensorModes={{ radar: "failed", visual: "normal" }} />);
    expect(screen.getByTitle("radar: failed")).toBeInTheDocument();
    expect(screen.getByTitle("visual: normal")).toBeInTheDocument();
  });

  it("offers to end the session", async () => {
    const onEnd = vi.fn();
    const user = userEvent.setup();
    render(<TopBar {...baseProps} onEnd={onEnd} />);

    await user.click(screen.getByRole("button", { name: /End session/i }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
