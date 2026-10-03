import { describe, expect, it } from "vitest";

import { TRUTH_BEARING_EVENT_TYPES, filterForRole } from "@skysentinel/shared";

import { createEventEmitter } from "./events.js";

describe("event emitter", () => {
  it("assigns gap-free monotonic sequence numbers", () => {
    const em = createEventEmitter();
    em.emit("session_started", { scenario_id: "s", seed: 1 });
    em.emit("contact_marked", { entity_id: "d1", category: "uas" });
    em.emit("classification_submitted", {
      entity_id: "d1",
      category: "uas",
      confidence: "high",
      correct: true,
    });

    expect(em.log().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("stamps events with simulation time, not wall-clock time", () => {
    const em = createEventEmitter({ startTime: 0 });
    em.setTime(1234);
    em.emit("session_started", { scenario_id: "s", seed: 1 });
    expect(em.log()[0]!.t_ms).toBe(1234);

    em.emit("session_started", { scenario_id: "s", seed: 1 }, { t_ms: 99 });
    expect(em.last("session_started")!.t_ms).toBe(99);
  });

  it("forces truth-bearing events to instructor visibility even if asked otherwise", () => {
    const em = createEventEmitter();

    for (const type of TRUTH_BEARING_EVENT_TYPES) {
      // `entity_state` and `entity_spawned` default to instructor; an explicit
      // trainee request must not downgrade them.
      const payload =
        type === "entity_spawned"
          ? { id: "d1", archetype: "quad_recon", affiliation_truth: "hostile" as const, intent: "recon" }
          : { id: "d1", pos: [1, 1, 100] as [number, number, number], vel: [0, 0, 0] as [number, number, number], behaviour_state: "transit" as const };

      const ev = em.emit(type, payload as never, { visibility: "trainee" });
      expect(ev.visibility).toBe("instructor");
    }
  });

  it("honours visibility for non-truth events", () => {
    const em = createEventEmitter();
    const ev = em.emit("radio_log", { channel: "net", message: "check" }, { visibility: "instructor" });
    expect(ev.visibility).toBe("instructor");
  });

  it("notifies subscribers and honours unsubscribe", () => {
    const em = createEventEmitter();
    const seen: string[] = [];
    const off = em.subscribe((e) => seen.push(e.type));

    em.emit("session_started", { scenario_id: "s", seed: 1 });
    off();
    em.emit("session_started", { scenario_id: "s", seed: 1 });

    expect(seen).toEqual(["session_started"]);
  });

  it("filters the log to a trainee role without truth events", () => {
    const em = createEventEmitter();
    em.emit("session_started", { scenario_id: "s", seed: 1 });
    em.emit("entity_spawned", {
      id: "d1",
      archetype: "quad_recon",
      affiliation_truth: "hostile",
      intent: "recon",
    });
    em.emit("contact_marked", { entity_id: "d1", category: "uas" });

    const trainee = filterForRole(em.log(), "trainee");
    expect(trainee.map((e) => e.type)).toEqual(["session_started", "contact_marked"]);
    expect(trainee.length).toBeLessThan(em.log().length);
  });

  it("records a byte-identical log for identical input", () => {
    const build = () => {
      const em = createEventEmitter();
      for (let t = 0; t < 50; t++) {
        em.setTime(t * 50);
        em.emit("entity_state", {
          id: `d${t % 3}`,
          pos: [t, t * 2, 100] as [number, number, number],
          vel: [1, 0, 0] as [number, number, number],
          behaviour_state: "transit",
        });
      }
      return JSON.stringify(em.log());
    };

    expect(build()).toBe(build());
  });
});