/**
 * Sensor barrel and degradation control (PRD §5.1 FR-SEN-6).
 */

import type { SensorId, SensorMode } from "@skysentinel/shared";

import { createFlightPlanSensor } from "./flightplan.js";
import { createIRSensor } from "./ir.js";
import { createRadarSensor } from "./radar.js";
import { createRFSensor } from "./rf.js";
import { createVisualSensor } from "./visual.js";
import type { Sensor } from "./types.js";

export * from "./types.js";
export { createFlightPlanSensor } from "./flightplan.js";
export { createIRSensor } from "./ir.js";
export { createRadarSensor } from "./radar.js";
export { createRFSensor } from "./rf.js";
export { createVisualSensor } from "./visual.js";

export const createSensor = (id: SensorId): Sensor => {
  switch (id) {
    case "visual":
      return createVisualSensor();
    case "ir":
      return createIRSensor();
    case "radar":
      return createRadarSensor();
    case "rf":
      return createRFSensor();
    case "flight_plan":
      return createFlightPlanSensor();
    default: {
      // Exhaustiveness guard: adding a sensor id without a case is a compile error.
      const _never: never = id;
      throw new Error(`Unknown sensor: ${String(_never)}`);
    }
  }
};

/** The standard five-sensor suite, in a fixed order. */
export const createSensorSuite = (): Sensor[] => [
  createSensor("radar"),
  createSensor("visual"),
  createSensor("ir"),
  createSensor("rf"),
  createSensor("flight_plan"),
];

export const setSensorMode = (sensor: Sensor, mode: SensorMode): void => {
  sensor.mode = mode;
};