import { useState } from "react";
import type { FusedTrack } from "@skysentinel/sim-core";
import type { ClassificationState } from "../types.js";
import {
  CLASSIFICATION_CATEGORIES,
  CONFIDENCE_LEVELS,
  PLATFORM_TYPES,
} from "@skysentinel/shared";

interface ClassificationFormProps {
  track: FusedTrack | null;
  classification: ClassificationState | undefined;
  onSubmit: (category: string, confidence: string, platform?: string) => void;
}

/**
 * Classification form (PRD §5.3 FR-DEC-2).
 *
 * Category + confidence + optional platform. Re-classification is
 * allowed and logged — the server records `is_reclassification`
 * and the scorer credits moving toward the evidence band.
 */
export default function ClassificationForm({
  track,
  classification,
  onSubmit,
}: ClassificationFormProps) {
  const [category, setCategory] = useState<string>("unknown");
  const [confidence, setConfidence] = useState<string>("medium");
  const [platform, setPlatform] = useState<string>("");

  const effectiveCategory = classification?.category ?? category;
  const effectiveConfidence = classification?.confidence ?? confidence;

  const submit = () => {
    if (track === null) return;
    onSubmit(category, confidence, platform === "" ? undefined : platform);
  };

  return (
    <div className="mt">
      <h3>Classification {track !== null ? `— ${track.track_id}` : ""}</h3>
      {track === null ? (
        <p className="dim small">Select a track to classify it.</p>
      ) : (
        <>
          <div className="classify-grid">
            {CLASSIFICATION_CATEGORIES.map((c, i) => (
              <button
                key={c}
                id={`classify-cat-${i}`}
                className={`cat-${c} ${effectiveCategory === c ? "selected" : ""}`}
                onClick={() => setCategory(c)}
                title={`Hotkey ${i + 1}`}
              >
                {c.replace("_", " ")}
              </button>
            ))}
          </div>
          <div className="flex mt wrap">
            {CONFIDENCE_LEVELS.map((c) => (
              <button
                key={c}
                className={effectiveConfidence === c ? "primary" : ""}
                onClick={() => setConfidence(c)}
              >
                {c}
              </button>
            ))}
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">platform: unknown</option>
              {PLATFORM_TYPES.map((p) => (
                <option key={p} value={p}>
                  {p.replace("_", " ")}
                </option>
              ))}
            </select>
            <button className="primary small" onClick={submit}>
              Submit classification
            </button>
          </div>
          {classification !== undefined && (
            <p className="small faint">
              Declared at {Math.round(classification.t_ms / 1000)}s
              {classification.is_reclassification ? " (re-classification)" : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}
