import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FusedTrack } from "@skysentinel/sim-core";
import type { AnySimEvent, SensorMode } from "@skysentinel/shared";
import type { ClientScenario } from "../types.js";

interface EoSceneProps {
  scenario: ClientScenario;
  tracks: readonly FusedTrack[];
  observations: readonly AnySimEvent[];
  mode: "eo" | "ir";
  selectedTrack: string | null;
  /**
   * Reports the bearing the reticle is pointing at, so the `Space` hotkey can mark
   * the contact under it rather than whatever is first in the cue list (PRD §13.1).
   * Polled at a few Hz, not per frame — a bearing is not frame-sensitive.
   */
  onBearing?: (bearing_deg: number) => void;
  /**
   * Tracks to draw on this animation frame, interpolated between the last two
   * frames (see `interpolate.ts`). Optional, for the static replay case.
   */
  readTracks?: () => readonly FusedTrack[];
}

/** Height above a marker at which its id label sits. */
const LABEL_OFFSET = new THREE.Vector3(0, 10, 0);
/** Altitude the fused-track markers are drawn at; tracks carry no altitude. */
const TRACK_ALT_M = 45;
/**
 * Fraction of the remaining gap a marker closes per animation frame.
 *
 * Purely presentational. The marker is already being given an interpolated target
 * once per wire frame; this absorbs the last of the step between two of those so
 * the motion is continuous. Below 1 so it settles rather than oscillating, and
 * frame-rate dependent by design — at 60 Hz it converges in well under the 50 ms
 * a wire frame takes to arrive.
 */
const GLIDE = 0.45;

interface TrackMarker {
  /** The whole per-track group: mesh, label, and the selection ring. */
  group: THREE.Group;
  /** The blip itself, restyled in place when a track's status changes. */
  mesh: THREE.Mesh;
  /** Where the blip should be, set from the interpolated position. */
  target: THREE.Vector3;
}

/**
 * 3D EO/IR view (PRD §5.3 FR-SEN-1/2, §13.1).
 *
 * The scene renders *sensor evidence*, never ground truth:
 * blips are positioned from the bearing/range/alt of the
 * observations the trainee was actually shown. Terrain is
 * procedural cosmetic geometry seeded from the scenario seed —
 * it gives spatial context, not information.
 *
 * ## Why the markers are not rebuilt each frame
 *
 * The first version cleared the blip group and reconstructed every marker from
 * the newest frame. That is what made contacts stutter: a 50 ms frame rate means
 * the blip sat still for two frames out of three and jumped on the third, and
 * the reconstruction churned geometries and materials 20 times a second for
 * nothing. Markers are now held across frames and eased toward the position the
 * render clock interpolates to, so the motion runs at the display's own refresh
 * rate while the sim keeps its 20 Hz record rate.
 *
 * Observation blips are still rebuilt each frame: they are static dots at the
 * positions a sensor *reported*, they do not move between frames, and they have
 * no identity to hold on to.
 */
export default function EoScene({
  scenario,
  tracks,
  observations,
  mode,
  selectedTrack,
  onBearing,
  readTracks,
}: EoSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onBearingRef = useRef(onBearing);
  onBearingRef.current = onBearing;
  const readTracksRef = useRef(readTracks);
  readTracksRef.current = readTracks;
  const markersRef = useRef<Map<string, TrackMarker>>(new Map());
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    /** Observation blips — rebuilt each frame. */
    blips: THREE.Group;
    /** Fused-track markers — held across frames and eased. */
    markers: THREE.Group;
    world: THREE.Group;
    raf: number;
  } | null>(null);

  // --- scene init, once ------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.minDistance = 5;
    controls.maxDistance = 1500;

    const world = new THREE.Group();
    const blips = new THREE.Group();
    const markers = new THREE.Group();
    scene.add(world, blips, markers);

    const state = { renderer, scene, camera, controls, world, blips, markers, raf: 0 };
    stateRef.current = state;
    markersRef.current.clear();

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const loop = () => {
      state.raf = requestAnimationFrame(loop);
      controls.update();
      // The one thing that runs per animation frame: move each marker a little
      // closer to where the last frame said it should be.
      for (const m of markersRef.current.values()) {
        m.group.position.lerp(m.target, GLIDE);
      }
      renderer.render(scene, camera);
    };
    loop();

    // The reticle points where the camera looks, which is `target - position`.
    // Sampled every ~15 frames: enough for a hotkey, cheap enough to not cost a
    // React render per frame.
    let samples = 0;
    const sampleBearing = () => {
      if (onBearingRef.current === undefined) return;
      samples++;
      if (samples < 15) return;
      samples = 0;
      const dir = state.controls.target.clone().sub(state.camera.position);
      const bearing = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
      onBearingRef.current(((bearing % 360) + 360) % 360);
    };
    const raf = () => {
      state.raf = requestAnimationFrame(raf);
      sampleBearing();
    };
    raf();

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      stateRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  // --- static world: terrain, buildings, assets, flight plans ----------------
  useEffect(() => {
    const st = stateRef.current;
    if (st === null) return;

    // dispose previous world
    st.world.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry?.dispose?.();
        const mat = o.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((m) => {
          if ("map" in m && m.map instanceof THREE.Texture) m.map.dispose();
          m.dispose();
        });
      }
    });
    st.world.clear();

    const ir = mode === "ir";
    const tod = scenario.environment.time_of_day;
    const weather = scenario.environment.weather;

    // Sky / fog
    const skyDay = 0x87a8c8;
    const skyDusk = 0x3a2f3f;
    const skyNight = 0x05070c;
    const sky = ir ? 0x000000 : tod === "day" ? skyDay : tod === "dusk" ? skyDusk : skyNight;
    st.scene.background = new THREE.Color(sky);
    const fogDist = weather === "clear" ? 1400 : weather === "haze" ? 900 : weather === "rain" ? 650 : weather === "fog" ? 380 : 520;
    st.scene.fog = new THREE.Fog(sky, fogDist * 0.35, fogDist);

    // Light
    const ambient = new THREE.AmbientLight(0xffffff, ir ? 0.9 : tod === "day" ? 0.95 : tod === "dusk" ? 0.5 : 0.18);
    const sun = new THREE.DirectionalLight(ir ? 0xffffff : tod === "dusk" ? 0xffb070 : 0xffffff, ir ? 0.2 : tod === "day" ? 0.8 : tod === "dusk" ? 0.5 : 0.08);
    sun.position.set(300, 500, 100);
    st.scene.add(ambient, sun);

    const obs = scenario.observer_post.pos;
    const ox = obs[0] ?? 0;
    const oy = obs[1] ?? 0;
    const oz = obs[2] ?? 3;

    // Ground
    const groundColor = ir ? 0x0a0a0a : scenario.environment.terrain === "urban" ? 0x2c3138 : 0x22301f;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshLambertMaterial({ color: groundColor }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(ox, 0, oy);
    st.world.add(ground);

    // Grid for spatial reference
    const grid = new THREE.GridHelper(1600, 32, 0x2a3440, 0x1a222b);
    grid.position.set(ox, 0.2, oy);
    st.world.add(grid);

    // Procedural structures, seeded so the same scenario always looks the same
    const rand = mulberry32(scenario.seed);
    const structColor = ir ? 0x161616 : 0x39424d;
    if (scenario.environment.terrain === "urban") {
      for (let i = 0; i < 46; i++) {
        const x = ox + (rand() - 0.5) * 1200;
        const z = oy + (rand() - 0.5) * 1200;
        if (Math.hypot(x - ox, z - oy) < 60) continue;
        const w = 14 + rand() * 26;
        const d = 14 + rand() * 26;
        const h = 12 + rand() * 68;
        const b = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshLambertMaterial({ color: structColor }),
        );
        b.position.set(x, h / 2, z);
        st.world.add(b);
      }
    } else {
      for (let i = 0; i < 70; i++) {
        const x = ox + (rand() - 0.5) * 1200;
        const z = oy + (rand() - 0.5) * 1200;
        if (Math.hypot(x - ox, z - oy) < 40) continue;
        const h = 8 + rand() * 18;
        const t = new THREE.Mesh(
          new THREE.ConeGeometry(4 + rand() * 5, h, 6),
          new THREE.MeshLambertMaterial({ color: ir ? 0x101010 : 0x1d2b1a }),
        );
        t.position.set(x, h / 2, z);
        st.world.add(t);
      }
    }

    // Protected assets: amber markers with priority labels
    for (const a of scenario.assets) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(4, 4, 4),
        new THREE.MeshLambertMaterial({ color: ir ? 0x664411 : 0xf0a832, emissive: ir ? 0x2a1c05 : 0x000000 }),
      );
      m.position.set(a.pos[0] ?? 0, 2, a.pos[1] ?? 0);
      st.world.add(m);
      const label = makeLabel(`${a.name} (P${a.priority})`, ir ? "#ffb84d" : "#f0a832");
      label.position.set(a.pos[0] ?? 0, 12, a.pos[1] ?? 0);
      st.world.add(label);
    }

    // Friendly flight plans: green lines
    for (const f of scenario.friendly_flights) {
      const pts = f.route.map((p) => new THREE.Vector3(p[0] ?? 0, 40, p[1] ?? 0));
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: ir ? 0x2f6f4f : 0x57ab7a, dashSize: 12, gapSize: 8 }),
      );
      line.computeLineDistances();
      st.world.add(line);
      const mid = f.route[Math.floor(f.route.length / 2)];
      if (mid !== undefined) {
        const label = makeLabel(f.label, ir ? "#4d9970" : "#57ab7a");
        label.position.set(mid[0] ?? 0, 55, mid[1] ?? 0);
        st.world.add(label);
      }
    }

    // Observer post marker
    const post = new THREE.Mesh(
      new THREE.ConeGeometry(2.5, 6, 4),
      new THREE.MeshLambertMaterial({ color: ir ? 0x555555 : 0x3fb6d9 }),
    );
    post.position.set(ox, 3, oy);
    st.world.add(post);

    // Camera at the observer post, looking north
    st.camera.position.set(ox, oz + 6, oy - 26);
    st.controls.target.set(ox, oz + 2, oy + 40);
    st.controls.update();
  }, [scenario, mode]);

  // --- observation blips: rebuilt each frame, never move between frames -------
  useEffect(() => {
    const st = stateRef.current;
    if (st === null) return;
    st.blips.clear();

    const ir = mode === "ir";
    const obs = scenario.observer_post.pos;
    const ox = obs[0] ?? 0;
    const oy = obs[1] ?? 0;

    const toVec = (bearingDeg: number, rangeM: number, altM: number): THREE.Vector3 => {
      const rad = (bearingDeg * Math.PI) / 180;
      return new THREE.Vector3(ox + rangeM * Math.sin(rad), altM, oy + rangeM * Math.cos(rad));
    };

    const recent = observations.slice(-160);
    for (const ev of recent) {
      if (ev.type !== "sensor_observation") continue;
      const p = ev.payload;
      if (p.sensor !== "visual" && p.sensor !== "ir") continue;
      const alt = p.alt_m ?? 30;
      const pos = toVec(p.bearing_deg, p.range_m ?? 0, alt);
      const ambiguous = p.shape === "ambiguous";
      let color: number;
      let opacity = 0.9;
      if (p.is_false) {
        color = ir ? 0x333333 : 0x5a6a78;
        opacity = 0.35;
      } else if (p.sensor === "ir") {
        color = ir ? 0xff8c2e : 0xff9a3d;
      } else {
        color = ir ? 0x2e6f8c : 0x3fb6d9;
      }
      const geo = ambiguous
        ? new THREE.IcosahedronGeometry(3, 0)
        : new THREE.SphereGeometry(p.sensor === "ir" ? 2.6 : 2.2, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, wireframe: ambiguous });
      const marker = new THREE.Mesh(geo, mat);
      marker.position.copy(pos);
      st.blips.add(marker);
    }
  }, [scenario, observations, mode]);

  // --- fused-track markers: held across frames, eased toward the target -------
  useEffect(() => {
    const st = stateRef.current;
    if (st === null) return;

    const ir = mode === "ir";
    const obs = scenario.observer_post.pos;
    const ox = obs[0] ?? 0;
    const oy = obs[1] ?? 0;

    const toVec = (bearingDeg: number, rangeM: number, altM: number): THREE.Vector3 => {
      const rad = (bearingDeg * Math.PI) / 180;
      return new THREE.Vector3(ox + rangeM * Math.sin(rad), altM, oy + rangeM * Math.cos(rad));
    };

    const live = readTracksRef.current?.() ?? tracks;
    const seen = new Set<string>();

    for (const t of live) {
      if (t.range_m === undefined) continue;
      const pos = toVec(t.bearing_deg, t.range_m, TRACK_ALT_M);
      seen.add(t.track_id);

      const color = ir
        ? 0xffffff
        : t.status === "lost"
          ? 0xe5534b
          : t.status === "confirmed"
            ? 0x57ab7a
            : t.status === "reacquired"
              ? 0xf0a832
              : 0x3fb6d9;
      const wireframe = t.status === "lost";

      const existing = markersRef.current.get(t.track_id);
      if (existing !== undefined) {
        existing.target.copy(pos);
        // Status and palette change between frames; restyle in place so the blip
        // does not blink as it re-acquires.
        const mat = existing.mesh.material as THREE.MeshBasicMaterial;
        mat.color.setHex(color);
        mat.wireframe = wireframe;
        continue;
      }

      // A new marker starts where it belongs. The first report of a track is a
      // whole jump, not a movement, and easing in from the origin would imply a
      // flight path that never happened.
      const group = new THREE.Group();
      group.position.copy(pos);

      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(4.5, 0),
        new THREE.MeshBasicMaterial({ color, wireframe }),
      );
      group.add(mesh);

      const label = makeLabel(t.track_id, "#cdd6df");
      label.position.copy(LABEL_OFFSET);
      group.add(label);

      if (t.track_id === selectedTrack) group.add(makeRing());

      st.markers.add(group);
      markersRef.current.set(t.track_id, { group, mesh, target: pos.clone() });
    }

    // Tracks that have aged out leave the scene rather than lingering where the
    // last frame put them.
    for (const [id, m] of markersRef.current) {
      if (seen.has(id)) continue;
      st.markers.remove(m.group);
      m.group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          o.geometry?.dispose?.();
          const mat = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(mat) ? mat : [mat]).forEach((x) => {
            if ("map" in x && x.map instanceof THREE.Texture) x.map.dispose();
            x.dispose();
          });
        }
      });
      markersRef.current.delete(id);
    }
  }, [scenario, tracks, mode, selectedTrack]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}

/** The white ring drawn around the selected track. */
const makeRing = (): THREE.Mesh => {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(8, 0.5, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  ring.rotation.x = Math.PI / 2;
  return ring;
};

/** Deterministic PRNG for cosmetic scene geometry (not sim logic). */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Text label as a sprite, so no external font assets are needed. */
const makeLabel = (text: string, color: string): THREE.Sprite => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d context");
  ctx.font = "600 28px monospace";
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  canvas.width = w;
  canvas.height = 40;
  const c2 = canvas.getContext("2d");
  if (c2 === null) throw new Error("no 2d context");
  c2.font = "600 28px monospace";
  c2.fillStyle = color;
  c2.textBaseline = "middle";
  c2.fillText(text, 8, 20);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w / 8, 5, 1);
  return sprite;
};

// Referenced so the type import stays honest about what we consume.
export type { SensorMode };