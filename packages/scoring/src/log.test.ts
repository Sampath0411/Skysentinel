/**
 * Log-reading tests.
 *
 * `readRun` is the boundary between a raw event stream and the decision tree, so
 * these tests are about *correlation*: getting from a cue to a truth entity to the
 * acts on it, and refusing to invent a correlation that is not there.
 */

import { describe, expect, it } from "vitest";
import type { AnySimEvent } from "@skysentinel/shared";
import type { ExpectedBlock } from "@skysentinel/scenario";

import { declaredCategories, readRun, tookAction, tookActionBefore } from "./log.js";
import type { Correlation } from "./types.js";
import type { TruthEntity } from "./types.js";

/** Build an event stream from compact tuples, keeping `seq` monotonic. */
const build = (rows: [string, number, Record<string, unknown>, string?][]): AnySimEvent[] =>
  rows.map(([type, t_ms, payload, actor], seq) => ({
    seq,
    t_ms,
    type,
    actor: actor ?? "trainee",
    visibility: "trainee",
    payload,
  })) as unknown as AnySimEvent[];

const TRUTH: ReadonlyMap<string, TruthEntity> = new Map([
  ["d1", { id: "d1", affiliation_truth: "hostile", intent: "payload" }],
  ["d2", { id: "d2", affiliation_truth: "friendly", intent: "transit" }],
]);

const CORRELATION: Correlation = {
  cue_truth: new Map([["C001", "d1"]]),
  track_truth: new Map([["T1", "d1"]]),
};

const EXPECTED: ExpectedBlock = {
  tracks: [
    {
      truth_id: "d1",
      correct_category: ["suspicious", "hostile"],
      hostile_ok: true,
      first_detectable_s: 0,
      par_detect_s: 5,
      required_report: true,
    },
  ],
  protect: [],
};

const input = (events: AnySimEvent[], correlation = CORRELATION) => ({
  scenario_id: "scr-test",
  seed: 1,
  duration_ms: 60_000,
  events,
  expected: EXPECTED,
  correlation,
  truth: TRUTH,
});

describe("readRun", () => {
  it("correlates a cue, its track, and the acts on it back to one entity", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["track_update", 1000, { track_id: "T1", sources: ["radar"], conf: 0.6, status: "new", pos_est: [0, 0, 0] }],
          ["contact_marked", 3000, { cue_or_track_id: "C001" }],
          ["classification_submitted", 4000, { track_id: "T1", category: "suspicious", confidence: "medium", evidence: [], is_reclassification: false }],
          ["action_taken", 5000, { action: "issue_warning", target_track_id: "T1", params: {} }],
        ]),
      ),
    );

    expect(facts.tracks).toHaveLength(1);
    const d1 = facts.tracks[0]!;
    expect(d1.truth_id).toBe("d1");
    expect(d1.first_cue_ms).toBe(1000);
    expect(d1.marked_ms).toBe(3000);
    expect(d1.declarations).toHaveLength(1);
    expect(d1.actions).toHaveLength(1);
    expect(d1.track_ids).toEqual(["T1"]);
  });

  it("ignores a repeat cue so it cannot shorten the measured detection latency", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["cue_presented", 9000, { cue_id: "C002", sensor: "visual", first_for_truth: false }],
          ["contact_marked", 3000, { cue_or_track_id: "C001" }],
        ]),
      ),
    );
    // If the 9s repeat counted, latency would read as 9 − 9 = 0s instead of 2s.
    expect(facts.tracks[0]!.first_cue_ms).toBe(1000);
  });

  it("uses only the first contact mark", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["contact_marked", 3000, { cue_or_track_id: "C001" }],
          ["contact_marked", 8000, { cue_or_track_id: "C001" }],
        ]),
      ),
    );
    expect(facts.tracks[0]!.marked_ms).toBe(3000);
  });

  it("records an unattributable cue rather than dropping it silently", () => {
    const facts = readRun(
      input(
        build([["cue_presented", 1000, { cue_id: "C999", sensor: "radar", first_for_truth: true }]]),
      ),
    );
    expect(facts.tracks).toHaveLength(0);
    expect(facts.unattributed["cue_presented"]).toBe(1);
  });

  it("accumulates the sensor union across track updates", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["track_update", 1000, { track_id: "T1", sources: ["radar"], conf: 0.5, status: "new", pos_est: [0, 0, 0] }],
          ["track_update", 2000, { track_id: "T1", sources: ["radar", "visual"], conf: 0.8, status: "confirmed", pos_est: [0, 0, 0] }],
        ]),
      ),
    );
    // Multi-source corroboration is what separates a high knowability band from a
    // medium one (PRD §9.4), so the scorer needs the union, not the latest list.
    expect([...facts.tracks[0]!.sources].sort()).toEqual(["radar", "visual"]);
  });

  it("orders tracks by first cue, then by id for a tie", () => {
    const correlation: Correlation = {
      cue_truth: new Map([["C001", "d2"], ["C002", "d1"]]),
      track_truth: new Map<string, string | null>([]),
    };
    const facts = readRun(
      input(
        build([
          ["cue_presented", 5000, { cue_id: "C002", sensor: "radar", first_for_truth: true }],
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
        ]),
        correlation,
      ),
    );
    expect(facts.tracks.map((t) => t.truth_id)).toEqual(["d2", "d1"]);
  });

  it("reads brief sections and the session end reason", () => {
    const facts = readRun(
      input(
        build([
          ["brief_viewed", 200, { sections_viewed: ["threat", "assets"] }],
          ["session_ended", 60_000, { scenario_id: "scr-test", seed: 1, end_reason: "completed" }],
        ]),
      ),
    );
    expect(facts.brief_viewed_ms).toBe(200);
    expect(facts.brief_sections).toEqual(["threat", "assets"]);
    expect(facts.session_end_reason).toBe("completed");
  });

  it("counts impacts and response effects", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["track_update", 1000, { track_id: "T1", sources: ["radar"], conf: 0.6, status: "new", pos_est: [0, 0, 0] }],
          ["action_taken", 5000, { action: "assign_track_owner", target_track_id: "T1", params: {} }],
          ["authority_resolved", 5200, { track_id: "T1", granted: true, reason: "policy" }],
          ["response_effect_resolved", 6000, { track_id: "T1", truth_id: "d1", outcome: "neutralised" }],
          ["impact", 30_000, { asset_id: "a1", damage: 0.4 }],
        ]),
      ),
    );
    expect(facts.impacts).toHaveLength(1);
    expect(facts.neutralised).toEqual(["d1"]);
    // N8 needs to know which tracks were actually worked, not merely observed.
    expect(facts.engaged).toEqual(["d1"]);
    expect(facts.tracks[0]!.authority_granted_seq).toBe(3);
  });

  it("marks a track reclassified after a second declaration", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["classification_submitted", 2000, { track_id: "T1", category: "unknown", confidence: "low", evidence: [], is_reclassification: false }],
          ["classification_submitted", 6000, { track_id: "T1", category: "suspicious", confidence: "medium", evidence: [], is_reclassification: true }],
        ]),
      ),
    );
    expect(facts.tracks[0]!.reclassified).toBe(true);
  });

  it("flags a report sent after a change as an update, not a first report", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["classification_submitted", 2000, { track_id: "T1", category: "unknown", confidence: "low", evidence: [], is_reclassification: false }],
          ["report_sent", 3000, { fields: { quantity: 1 }, linked_track_id: "T1", delay_ms: 0 }],
          ["classification_submitted", 6000, { track_id: "T1", category: "hostile", confidence: "high", evidence: [], is_reclassification: true }],
          ["report_sent", 7000, { fields: { quantity: 1 }, linked_track_id: "T1", delay_ms: 0 }],
        ]),
      ),
    );
    const reports = facts.tracks[0]!.reports;
    expect(reports).toHaveLength(2);
    expect(reports[0]!.after_material_change).toBe(false);
    expect(reports[1]!.after_material_change).toBe(true);
  });

  it("does not call a repeat report an update when nothing changed since the last one", () => {
    // The opposite failure from the one above: a trainee re-sending the same
    // picture has not updated it, and must not collect the update bonus.
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["classification_submitted", 2000, { track_id: "T1", category: "unknown", confidence: "low", evidence: [], is_reclassification: false }],
          ["report_sent", 3000, { fields: { quantity: 1 }, linked_track_id: "T1", delay_ms: 0 }],
          ["report_sent", 4000, { fields: { quantity: 1 }, linked_track_id: "T1", delay_ms: 0 }],
        ]),
      ),
    );
    expect(facts.tracks[0]!.reports[1]!.after_material_change).toBe(false);
  });

  it("records loss and reacquisition times for N10", () => {
    const facts = readRun(
      input(
        build([
          ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
          ["track_update", 1000, { track_id: "T1", sources: ["radar"], conf: 0.6, status: "new", pos_est: [0, 0, 0] }],
          ["track_lost", 10_000, { track_id: "T1" }],
          ["track_reacquired", 14_000, { track_id: "T1" }],
        ]),
      ),
    );
    expect(facts.tracks[0]!.track_lost_ms).toBe(10_000);
    expect(facts.tracks[0]!.track_reacquired_ms).toBe(14_000);
  });
});

describe("fact helpers", () => {
  const facts = readRun(
    input(
      build([
        ["cue_presented", 1000, { cue_id: "C001", sensor: "radar", first_for_truth: true }],
        ["classification_submitted", 2000, { track_id: "T1", category: "unknown", confidence: "low", evidence: [], is_reclassification: false }],
        ["classification_submitted", 6000, { track_id: "T1", category: "hostile", confidence: "high", evidence: [], is_reclassification: true }],
        ["action_taken", 7000, { action: "issue_warning", target_track_id: "T1", params: {} }],
        ["action_taken", 9000, { action: "execute_response", target_track_id: "T1", params: {} }],
      ]),
    ),
  );
  const d1 = facts.tracks[0]!;

  it("lists distinct declared categories in order", () => {
    expect(declaredCategories(d1)).toEqual(["unknown", "hostile"]);
  });

  it("finds an action anywhere on the track", () => {
    expect(tookAction(d1, "execute_response")?.t_ms).toBe(9000);
    expect(tookAction(d1, "stand_down")).toBeUndefined();
  });

  it("finds an action only up to a time", () => {
    expect(tookActionBefore(d1, "execute_response", 8000)).toBeUndefined();
    expect(tookActionBefore(d1, "execute_response", 9000)?.t_ms).toBe(9000);
  });
});