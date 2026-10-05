/**
 * Server-side action validation (PRD §15).
 *
 * The client sends *intent* — "I want to do this" — and this module decides whether
 * the trainee is allowed to. Nothing a client sends is taken on trust, because a
 * score that can be earned by posting events directly is not a score.
 *
 * The load-bearing case is `execute_response`. PRD §15 is explicit that the server
 * rejects it unless authority was granted, and §10.5 makes an unauthorised response
 * a critical error. Both are only meaningful if the gate is here: if the client
 * checked its own button state, a trainee could skip the request, act anyway, and
 * the resulting `UNAUTHORISED_ACTION` critical would be an artefact of the client
 * rather than a measurement of the trainee.
 */

import type { TraineeControls, TraineeView } from "@skysentinel/sim-core";
import type { ClassificationCategory, Confidence, ResponseAction } from "@skysentinel/shared";

export type ActionOutcome = { ok: true } | { ok: false; reason: string };

/** The part of a live session an action needs. Narrower than `LiveSession`. */
export interface ActionTarget {
  controls(): TraineeControls;
  view(): TraineeView;
}

/**
 * Apply one action, or explain why not.
 *
 * Every failure path returns a reason that is safe to show a trainee. "No authority
 * for that track. Request authorisation first." teaches the loop; "409" teaches
 * nothing.
 */
export const applyAction = (
  target: ActionTarget,
  type: string,
  payload: Record<string, unknown>,
): ActionOutcome => {
  const controls = target.controls();

  switch (type) {
    case "mark_contact": {
      const cue_id = str(payload, "cue_id");
      if (cue_id === undefined) return { ok: false, reason: "No cue given." };
      return controls.markContact(cue_id)
        ? { ok: true }
        : { ok: false, reason: "That contact is not available to mark." };
    }

    case "classify": {
      const track_id = str(payload, "track_id");
      const category = str(payload, "category") as ClassificationCategory | undefined;
      const confidence = str(payload, "confidence") as Confidence | undefined;

      if (!track_id) return { ok: false, reason: "No track selected." };
      if (!category) return { ok: false, reason: "No classification selected." };
      if (!confidence) return { ok: false, reason: "No confidence selected." };

      const platform = str(payload, "platform");
      controls.classify({
        track_id,
        category,
        confidence,
        ...(platform !== undefined ? { platform } : {}),
      });
      return { ok: true };
    }

    case "report": {
      const track_id = str(payload, "track_id");
      const quantity = num(payload, "quantity");
      const bearing_deg = num(payload, "bearing_deg");
      const range_m = num(payload, "range_m");
      const activity = str(payload, "activity");
      const description = str(payload, "description");

      if (track_id === undefined && activity === undefined && description === undefined) {
        return { ok: false, reason: "A report needs at least a track, an activity or a description." };
      }

      controls.report({
        ...(track_id !== undefined ? { track_id } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(bearing_deg !== undefined ? { bearing_deg } : {}),
        ...(range_m !== undefined ? { range_m } : {}),
        ...(activity !== undefined ? { activity } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return { ok: true };
    }

    case "request_authority": {
      const track_id = str(payload, "track_id");
      if (!track_id) return { ok: false, reason: "No track selected." };
      return controls.requestAuthority(track_id)
        ? { ok: true }
        : { ok: false, reason: "That track cannot be escalated." };
    }

    case "view_brief": {
      const raw = payload["sections"];
      // An absent `sections` means "the whole brief", which is the default the
      // session harness implements (D25). A present-but-empty list means nothing
      // and is rejected, rather than being silently widened.
      const sections = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : undefined;
      return controls.viewBrief(sections)
        ? { ok: true }
        : { ok: false, reason: "That section is not in this brief." };
    }

    case "act": {
      const action = str(payload, "action") as ResponseAction | undefined;
      if (!action) return { ok: false, reason: "No action given." };

      const track_id = str(payload, "track_id");
      const asset_id = str(payload, "asset_id");

      // The authority gate. See the module doc comment for why it lives here.
      if (action === "execute_response" && track_id !== undefined) {
        if (!target.view().authority.granted.includes(track_id)) {
          return {
            ok: false,
            reason: "You do not have authority for that track. Request authorisation first.",
          };
        }
      }

      return controls.act(action, {
        ...(track_id !== undefined ? { track_id } : {}),
        ...(asset_id !== undefined ? { asset_id } : {}),
      })
        ? { ok: true }
        : { ok: false, reason: "That action is not available right now." };
    }

    default:
      return { ok: false, reason: "Unrecognised action." };
  }
};

/** A `Session` satisfies `ActionTarget` structurally; named for readability. */
export type ActionSource = ActionTarget;

const str = (payload: Record<string, unknown>, key: string): string | undefined => {
  const v = payload[key];
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v;
};

const num = (payload: Record<string, unknown>, key: string): number | undefined => {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};