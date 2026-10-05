/**
 * Client view models.
 *
 * `foldClassifications` is the one piece of real logic in `types.ts` — the track
 * panel shows "latest declaration per track", and a re-classification must replace
 * the earlier one rather than appear beside it, otherwise a track the trainee
 * corrected still reads as the wrong call.
 */

import { describe, expect, it } from "vitest";

import type { AnySimEvent, ClassificationCategory, Confidence } from "@skysentinel/shared";

import { type ClassificationState, emptyClassificationLog, foldClassifications } from "./types.js";

const classify = (
  track_id: string,
  category: ClassificationCategory,
  t_ms: number,
  extra: { confidence?: Confidence; platform?: string; is_reclassification?: boolean; seq?: number } = {},
): AnySimEvent => ({
  seq: extra.seq ?? 0,
  type: "classification_submitted",
  t_ms,
  actor: "trainee",
  visibility: "trainee",
  payload: {
    track_id,
    category,
    confidence: extra.confidence ?? "high",
    evidence: [],
    is_reclassification: extra.is_reclassification ?? false,
    ...(extra.platform !== undefined ? { platform: extra.platform } : {}),
  },
});

describe("foldClassifications", () => {
  it("ignores everything that is not a classification", () => {
    // The fold runs over the whole event log every frame; a cue or a track update
    // landing in `latest` would invent a declaration the trainee never made.
    const events: AnySimEvent[] = [
      {
        type: "cue_presented",
        seq: 0,
        t_ms: 0,
        actor: "sim",
        visibility: "trainee",
        payload: { sensor: "radar", cue_id: "C1", first_for_truth: true },
      },
      {
        type: "track_update",
        seq: 1,
        t_ms: 0,
        actor: "sim",
        visibility: "trainee",
        payload: { track_id: "T1", status: "confirmed", conf: 0.9, sources: ["radar"], pos_est: [0, 0, 0] },
      },
    ];
    expect(foldClassifications(events)).toEqual(emptyClassificationLog());
  });

  it("keeps the latest declaration per track and the full history in order", () => {
    const events: AnySimEvent[] = [
      classify("T1", "hostile", 1_000),
      classify("T2", "friendly", 2_000),
      classify("T1", "friendly", 3_000, { is_reclassification: true }),
    ];

    const log = foldClassifications(events);

    expect([...log.latest.keys()]).toEqual(["T1", "T2"]);
    expect(log.latest.get("T1")?.category).toBe("friendly");
    expect(log.latest.get("T1")?.is_reclassification).toBe(true);
    expect(log.latest.get("T2")?.category).toBe("friendly");
    // History is append-only: the AAR shows every declaration, not just the last.
    expect(log.history.map((h) => `${h.track_id}:${h.category}@${h.t_ms}`)).toEqual([
      "T1:hostile@1000",
      "T2:friendly@2000",
      "T1:friendly@3000",
    ]);
  });

  it("only carries a platform through when the event had one", () => {
    // `platform` is optional on both the event and the view model; a track declared
    // without one must not inherit a stale or undefined-but-present value.
    const latest = foldClassifications([
      classify("T1", "hostile", 1_000),
      classify("T2", "hostile", 2_000, { platform: "quadcopter" }),
    ]).latest;

    expect("platform" in (latest.get("T1") as ClassificationState)).toBe(false);
    expect(latest.get("T2")?.platform).toBe("quadcopter");
  });

  it("starts empty", () => {
    expect(foldClassifications([])).toEqual(emptyClassificationLog());
  });
});
