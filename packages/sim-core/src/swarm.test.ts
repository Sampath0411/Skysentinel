import { describe, expect, it } from "vitest";

import { BREAK_DELAY_MS, applyReactiveRule, formSwarm, formationTarget, isSwarmRole, orderRetreat } from "./swarm.js";
import { createDrone, type Drone } from "./entities.js";
import { createTerrain } from "./terrain/index.js";

const terrain = createTerrain("rural", 11, 2000);

const member = (id: string, role: Drone["role"], pos: { x: number; y: number; z: number }): Drone =>
  createDrone({
    id,
    archetype: "quad_recon",
    affiliation_truth: "hostile",
    intent: "recon",
    pos,
    spawn_t_ms: 0,
    speed_mps: 15,
    programme: [{ state: "approach_direct", to: { x: 0, y: 0, z: 100 }, speed: 15 }],
    rf_emitting: false,
    spawned_seq: 0,
    ...(role ? { role } : {}),
    ...(role ? { group_id: "g1" } : {}),
  });

const members = (): Drone[] => [
  member("d3", "follow_on", { x: 300, y: 0, z: 100 }),
  member("d1", "main", { x: 200, y: 0, z: 100 }),
  member("d2", "scout", { x: 250, y: 0, z: 100 }),
];

describe("swarm formation (FR-SIM-6)", () => {
  it("orders members stably by id and picks `main` as leader", () => {
    const swarm = formSwarm("g1", members(), 0);
    expect(swarm.member_ids).toEqual(["d1", "d2", "d3"]);
    expect(swarm.leader_id).toBe("d1");
  });

  it("falls back to the lowest id when no member is `main`", () => {
    const swarm = formSwarm("g1", [member("z9", "scout", { x: 0, y: 0, z: 100 }), member("a1", "decoy", { x: 0, y: 0, z: 100 })], 0);
    expect(swarm.leader_id).toBe("a1");
  });

  it("rotates formation offsets into the leader's heading frame", () => {
    const leader = member("d1", "main", { x: 0, y: 0, z: 100 });
    const scout = member("d2", "scout", { x: 0, y: 0, z: 100 });

    leader.heading_deg = 0; // north
    const north = formationTarget(leader, scout);
    expect(north.y).toBeGreaterThan(leader.pos.y);

    leader.heading_deg = 90; // east
    const east = formationTarget(leader, scout);
    expect(east.x).toBeGreaterThan(leader.pos.x);
    expect(Math.hypot(east.x - leader.pos.x, east.y - leader.pos.y)).toBeCloseTo(120, 3);
  });

  it("holds the same relative distance regardless of heading", () => {
    const leader = member("d1", "main", { x: 0, y: 0, z: 100 });
    const scout = member("d2", "scout", { x: 0, y: 0, z: 100 });
    const byId = member("d2", "scout", { x: 0, y: 0, z: 100 });

    for (const h of [0, 45, 137, 270, 359]) {
      leader.heading_deg = h;
      const t = formationTarget(leader, scout);
      const flat = Math.hypot(t.x - leader.pos.x, t.y - leader.pos.y);
      expect(Math.abs(flat - 120)).toBeLessThan(0.01);
    }
    expect(byId.id).toBe("d2");
  });

  it("does not break formation while the leader is flying", () => {
    const swarm = formSwarm("g1", members(), 0);
    const map = new Map(members().map((m) => [m.id, m]));

    expect(applyReactiveRule(swarm, map, BREAK_DELAY_MS - 1)).toEqual([]);
    expect(swarm.broken).toBe(false);
  });

  it("breaks formation and orders a retreat once the leader is neutralised", () => {
    const list = members();
    const swarm = formSwarm("g1", list, 0);
    const map = new Map(list.map((m) => [m.id, m]));
    map.get("d1")!.neutralised = true;

    const retreating = applyReactiveRule(swarm, map, 100);
    expect(retreating).toEqual(["d2", "d3"]);
    expect(swarm.broken).toBe(true);

    orderRetreat(map, retreating, terrain);
    for (const id of retreating) {
      const m = map.get(id)!;
      expect(m.behaviour_state).toBe("retreat");
      expect(m.programme[0]!.state).toBe("retreat");
    }
  });

  it("fires only once", () => {
    const list = members();
    const swarm = formSwarm("g1", list, 0);
    const map = new Map(list.map((m) => [m.id, m]));
    map.get("d1")!.neutralised = true;

    expect(applyReactiveRule(swarm, map, 100)).toHaveLength(2);
    expect(applyReactiveRule(swarm, map, 200)).toEqual([]);
  });

  it("recognition covers the shared vocabulary and nothing invented", () => {
    expect(isSwarmRole("main")).toBe(true);
    expect(isSwarmRole("scout")).toBe(true);
    expect(isSwarmRole("decoy")).toBe(true);
    expect(isSwarmRole("follow_on")).toBe(true);
    expect(isSwarmRole("leader")).toBe(false);
  });
});