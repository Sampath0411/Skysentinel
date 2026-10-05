import { useState } from "react";
import type { NodeResult } from "@skysentinel/scoring";

interface ScoreTreeProps {
  nodes: readonly NodeResult[];
  /** Jump the AAR timeline to the event with this seq. */
  onJump: (seq: number) => void;
}

interface TreeNode {
  node: NodeResult;
  children: TreeNode[];
}

/**
 * Score-explanation tree (PRD §12.5).
 *
 * The scorer emits a flat list with dotted ids
 * (`N5.det.hostile-1`); this rebuilds the hierarchy
 * so every point can be expanded to its reason and
 * the events that earned it.
 */
export default function ScoreTree({ nodes, onJump }: ScoreTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.filter((n) => !n.id.includes(".")).map((n) => n.id)),
  );

  const tree = buildTree(nodes);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="score-tree">
      {tree.map((n) => (
        <Node key={n.node.id} node={n} expanded={expanded} onToggle={toggle} onJump={onJump} />
      ))}
      {nodes.length === 0 && <p className="dim small">No score nodes recorded for this run.</p>}
    </div>
  );
}

const Node = ({
  node,
  expanded,
  onToggle,
  onJump,
}: {
  node: TreeNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onJump: (seq: number) => void;
}) => {
  const isOpen = expanded.has(node.node.id);
  const ratio = node.node.max_points > 0 ? node.node.points / node.node.max_points : 0;
  const passed = node.node.passed;
  return (
    <div>
      <div className="node-head" onClick={() => onToggle(node.node.id)}>
        <span className="faint">{isOpen ? "▾" : "▸"}</span>
        <span className="label">{node.node.label}</span>
        <span className={`points ${passed ? "pass" : "fail"}`}>
          {node.node.points.toFixed(0)}/{node.node.max_points}
        </span>
        <span
          className="conf-bar"
          style={{ width: 44, margin: 0 }}
          title={`${(ratio * 100).toFixed(0)}% of available`}
        >
          <div
            style={{
              width: `${(ratio * 100).toFixed(0)}%`,
              background: passed ? "var(--green)" : "var(--red)",
            }}
          />
        </span>
      </div>
      {isOpen && (
        <>
          {node.node.reason !== "" && (
            <div className="reason">{node.node.reason}</div>
          )}
          {node.node.event_refs.length > 0 && (
            <div className="reason">
              events:
              {node.node.event_refs.map((seq) => (
                <span
                  key={seq}
                  className="evt-ref"
                  onClick={(e) => {
                    e.stopPropagation();
                    onJump(seq);
                  }}
                  title="Jump the timeline to this event"
                >
                  #{seq}
                </span>
              ))}
            </div>
          )}
          {node.children.map((c) => (
            <Node key={c.node.id} node={c} expanded={expanded} onToggle={onToggle} onJump={onJump} />
          ))}
        </>
      )}
    </div>
  );
};

const buildTree = (nodes: readonly NodeResult[]): TreeNode[] => {
  const roots: TreeNode[] = [];
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    const treeNode: TreeNode = { node: n, children: [] };
    byId.set(n.id, treeNode);
  }
  for (const n of nodes) {
    const treeNode = byId.get(n.id);
    if (treeNode === undefined) continue;
    const dot = n.id.lastIndexOf(".");
    const parent = dot > 0 ? byId.get(n.id.slice(0, dot)) : undefined;
    if (parent !== undefined) parent.children.push(treeNode);
    else roots.push(treeNode);
  }
  return roots;
};
