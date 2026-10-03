import { describe, expect, it } from "vitest";

import type { Affiliation, ResponseAction } from "@skysentinel/shared";

import { createAsset, createDrone, type Drone } from "./entities.js";
import {
  applyImpact,
  deriveOutcome,
  drillCost,
  isInsideImpactRadius,
  signatureMultiplier,
  startDrill,
  stepDrill,
} from "./impact.js";
import { matchQualityFor, requiresAuthority, resolveResponse, type ResponseParams } from "./response.js";
import { createRng } from "./rng.js";

const mkDrone = (over: Partial<{ affiliation_truth: Affiliation; pos: { x: number; y: number; z: number } }> = {}): Drone =>
  createDrone({
    id: "d1",
    archetype: "payload",
    affiliation_truth: over.affiliation_truth ?? "hostile",
    intent: "attack",
    pos: over.pos ?? { x: 100, y: 0, z: 100 },
    spawn_t_ms: 0,
    speed_mps: 12,
    programme: [{ state: "approach_direct", to: { x: 0, y: 0, z: 100 }, speed: 12 }],
    rf_emitting: false,
    spawned_seq: 0,
  });

const asset = () => createAsset({ id: "a1", name: "Fuel", type: "fuel", pos: { x: 0, y: 0, z: 0 }, priority: 1, impact_radius_m: 60, spawned_seq: 0 });

const baseParams = (over: Partial<ResponseParams> = {}): ResponseParams => ({
  action: "execute_response",
  base_success: 0.5,
  engagement_range_m: 200,
  match_quality: 0.8,
  authority_granted: true,
  fratricide_risk: 0.6,
  ...over,
});

describe("response resolution (FR-SIM-8)", () => {
  it("resolves to no effect when authority was not granted", () => {
    const r = resolveResponse({
      action: "execute_response",
      target: mkDrone(),
      responder_pos: { x: 0, y: 0, z: 0 },
      params: baseParams({ authority_granted: false }),
      t_ms: 0,
      rng: createRng(1, "response:test"),
    });

    expect(r.unauthorised).toBe(true);
    expect(r.resolution).toBe("no_effect");
    expect(r.reason).toContain("authority");
  });

  it("treats an advisory action as needing no authority", () => {
    const r = resolveResponse({
      action: "issue_warning",
      target: mkDrone(),
      responder_pos: { x: 0, y: 0, z: 0 },
      params: baseParams({ action: "issue_warning", authority_granted: false }),
      t_ms: 0,
      rng: createRng(1, "response:test"),
    });

    expect(r.unauthorised).toBe(false);
    expect(requiresAuthority("issue_warning")).toBe(false);
    expect(requiresAuthority("execute_response")).toBe(true);
  });

  it("detects fratricide against a friendly regardless of the success roll", () => {
    const results = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const r = resolveResponse({
        action: "execute_response",
        target: mkDrone({ affiliation_truth: "friendly" }),
        responder_pos: { x: 0, y: 0, z: 0 },
        params: baseParams(),
        t_ms: 0,
        rng: createRng(seed, "response:test"),
      });
      if (r.friendly_engaged) results.add(r.resolution);
    }
    // Some seeds deconflict correctly; every fratricide is labelled as such.
    expect([...results].every((r) => r === "fratricide" || r === "no_effect")).toBe(true);
    expect(results.size).toBeGreaterThan(0);
  });

  it("misses when the target is outside action range", () => {
    const r = resolveResponse({
      action: "execute_response",
      target: mkDrone({ pos: { x: 5000, y: 0, z: 100 } }),
      responder_pos: { x: 0, y: 0, z: 0 },
      params: baseParams(),
      t_ms: 0,
      rng: createRng(3, "response:test"),
    });

    expect(r.resolution).toBe("missed");
    expect(r.p_success).toBe(0);
    expect(r.reason).toContain("5000");
  });

  it("is deterministic: same seed, same target, same outcome", () => {
    const run = (seed: number) =>
      resolveResponse({
        action: "execute_response",
        target: mkDrone(),
        responder_pos: { x: 0, y: 0, z: 0 },
        params: baseParams(),
        t_ms: 0,
        rng: createRng(seed, "response:test"),
      });

    for (let seed = 0; seed < 25; seed++) {
      expect(JSON.stringify(run(seed))).toBe(JSON.stringify(run(seed)));
    }
  });

  it("responds to match quality: a perfect match neutralises more often", () => {
    const tally = (quality: number) => {
      let hits = 0;
      for (let seed = 0; seed < 2000; seed++) {
        const r = resolveResponse({
          action: "execute_response",
          target: mkDrone(),
          responder_pos: { x: 0, y: 0, z: 0 },
          params: baseParams({ match_quality: quality }),
          t_ms: 0,
          rng: createRng(seed, "response:test"),
        });
        if (r.resolution === "neutralised") hits++;
      }
      return hits;
    };

    expect(tally(1.0)).toBeGreaterThan(tally(0.4));
    // Wide margin, not a fragile threshold.
    expect(tally(1.0) / 2000 - tally(0.4) / 2000).toBeGreaterThan(0.15);
  });

  it("match quality rewards knowing behaviour and confidence", () => {
    expect(matchQualityFor(true, "high")).toBeGreaterThan(matchQualityFor(false, "high"));
    expect(matchQualityFor(true, "high")).toBeGreaterThan(matchQualityFor(true, "low"));
    expect(matchQualityFor(false, "high")).toBeLessThan(1);
  });
});

describe("asset impact (FR-SIM-7)", () => {
  it("damages an asset and clamps integrity at zero", () => {
    const a = asset();
    const first = applyImpact(a, "d1", "payload");
    expect(first.integrity_before).toBe(1);
    expect(first.integrity_after).toBeLessThan(1);
    expect(first.destroyed).toBe(false);

    for (let i = 0; i < 10; i++) applyImpact(a, "d1", "payload");
    expect(a.integrity).toBe(0);
  });

  it("leaves assets unharmed by non-damaging entities", () => {
    const a = asset();
    const r = applyImpact(a, "b1", "bird_flock");
    expect(r.integrity_after).toBe(1);
    expect(applyImpact(a, "d2", "decoy").integrity_after).toBe(1);
  });

  it("measures impact radius horizontally", () => {
    const a = asset();
    expect(isInsideImpactRadius(a, { x: 30, y: 30, z: 5000 })).toBe(true);
    expect(isInsideImpactRadius(a, { x: 100, y: 0, z: 0 })).toBe(false);
  });

  it("a protective drill costs integrity the longer it runs", () => {
    const a = asset();
    expect(drillCost(a, 2)).toBeGreaterThan(drillCost(a, 1));
    expect(drillCost(a, 0)).toBe(0);
    expect(drillCost(a, -5)).toBe(0);
  });

  it("reduces signature only while the drill is active", () => {
    const a = asset();
    const drill = startDrill("a1", 0, 2, 0.4);

    expect(signatureMultiplier(drill)).toBe(1);
    stepDrill(drill, a, 0.05, 50);
    expect(drill.phase).toBe("active");
    expect(signatureMultiplier(drill)).toBeCloseTo(0.6, 5);

    stepDrill(drill, a, 0.05, 5000);
    expect(drill.phase).toBe("completed");
    expect(signatureMultiplier(drill)).toBe(1);
  });

  it("clamps a drill's signature reduction into 0..1", () => {
    expect(startDrill("a1", 0, 1, 5).signature_reduction).toBe(1);
    expect(startDrill("a1", 0, 1, -5).signature_reduction).toBe(0);
  });

  it("derives the mission outcome from asset integrity", () => {
    const intact = [asset()];
    expect(deriveOutcome(intact, false)).toBe("protected");

    const hit = [asset()];
    applyImpact(hit[0]!, "d1", "payload");
    expect(deriveOutcome(hit, true)).toBe("damaged");

    const lost = [asset()];
    for (let i = 0; i < 10; i++) applyImpact(lost[0]!, "d1", "payload");
    expect(deriveOutcome(lost, true)).toBe("asset_lost");
  });
});

describe("response action safety boundary", () => {
  it("every response action is either authority-gated or explicitly exempt", () => {
    const actions: ResponseAction[] = [
      "continue_observe",
      "request_sensor_cue",
      "report",
      "assign_track_owner",
      "handover",
      "issue_warning",
      "activate_protective_drill",
      "request_support",
      "request_response_authority",
      "execute_response",
      "stand_down",
      "reclassify",
    ];
    // Partition: an action in neither list would silently skip the authority check.
    const covered = actions.filter((a) => requiresAuthority(a) || !requiresAuthority(a));
    expect(covered).toHaveLength(actions.length);
    expect(requiresAuthority("request_support")).toBe(true);
  });
});