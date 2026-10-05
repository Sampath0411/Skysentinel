import type { ReactNode } from "react";

/**
 * Hand-rolled SVG charts (PRD §6.1 lists Recharts; these
 * cover the AAR's line/bar/radar needs with zero extra
 * bundle, which matters for an offline app).
 */

interface LineChartProps {
  points: readonly (number | null)[];
  labels?: readonly string[];
  width?: number;
  height?: number;
  color?: string;
  yMin?: number;
  yMax?: number;
}

export const LineChart = ({
  points,
  labels,
  width = 560,
  height = 160,
  color = "#3fb6d9",
  yMin = 0,
  yMax = 100,
}: LineChartProps) => {
  const pad = 24;
  const iw = width - pad * 2;
  const ih = height - pad * 2;
  const vals = points.map((p) => (p === null ? NaN : p));
  const x = (i: number) => pad + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad + ih - ((v - yMin) / Math.max(1, yMax - yMin)) * ih;

  const path = vals
    .map((v, i) => (Number.isNaN(v) ? null : `${i === 0 || Number.isNaN(vals[i - 1] ?? NaN) ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter((s): s is string => s !== null)
    .join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img">
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}>
          <line x1={pad} x2={width - pad} y1={y(g)} y2={y(g)} stroke="#232c37" strokeWidth={1} />
          <text x={2} y={y(g) + 3} fontSize={12} fill="#5a6a78" className="chart-label">
            {g}
          </text>
        </g>
      ))}
      {path !== "" && <path d={path} fill="none" stroke={color} strokeWidth={2} />}
      {vals.map((v, i) =>
        Number.isNaN(v) ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={color} />
        ),
      )}
      {labels?.map((l, i) => (
        <text key={i} x={x(i)} y={height - 6} fontSize={12} fill="#5a6a78" textAnchor="middle">
          {l}
        </text>
      ))}
    </svg>
  );
};

interface BarChartProps {
  data: readonly { label: string; value: number }[];
  width?: number;
  height?: number;
  color?: string;
  max?: number;
}

export const BarChart = ({
  data,
  width = 560,
  height = 160,
  color = "#f0a832",
  max,
}: BarChartProps) => {
  const pad = 24;
  const iw = width - pad * 2;
  const ih = height - pad * 2;
  const top = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  const bw = data.length > 0 ? iw / data.length : iw;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img">
      {data.map((d, i) => {
        const bh = (d.value / top) * ih;
        return (
          <g key={i}>
            <rect
              x={pad + i * bw + bw * 0.15}
              y={pad + ih - bh}
              width={bw * 0.7}
              height={bh}
              fill={color}
            />
            <text x={pad + i * bw + bw / 2} y={pad + ih - bh - 4} fontSize={12} fill="#cdd6df" textAnchor="middle">
              {d.value}
            </text>
            <text x={pad + i * bw + bw / 2} y={height - 6} fontSize={12} fill="#5a6a78" textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

interface RadarChartProps {
  axes: readonly { label: string; value: number }[];
  size?: number;
}

export const RadarChart = ({ axes, size = 220 }: RadarChartProps) => {
  const c = size / 2;
  const r = c - 28;
  const n = axes.length;
  const angle = (i: number) => (i / n) * Math.PI * 2 - Math.PI / 2;
  const point = (i: number, v: number): [number, number] => [
    c + Math.cos(angle(i)) * r * (v / 100),
    c + Math.sin(angle(i)) * r * (v / 100),
  ];
  const poly = axes.map((a, i) => point(i, a.value).join(",")).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} role="img">
      {[25, 50, 75, 100].map((g) => (
        <polygon
          key={g}
          points={axes.map((_, i) => point(i, g).join(",")).join(" ")}
          fill="none"
          stroke="#232c37"
          strokeWidth={1}
        />
      ))}
      {axes.map((_, i) => {
        const [x, y] = point(i, 100);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="#232c37" strokeWidth={1} />;
      })}
      <polygon points={poly} fill="rgba(63,182,217,0.2)" stroke="#3fb6d9" strokeWidth={2} />
      {axes.map((a, i) => {
        const [x, y] = point(i, a.value);
        const [lx, ly] = point(i, 118);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={3} fill="#3fb6d9" />
            <text x={lx} y={ly + 3} fontSize={12} fill="#8494a3" textAnchor="middle">
              {a.label.slice(0, 9)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

interface HistogramProps {
  values: readonly number[];
  bins?: number;
  min: number;
  max: number;
  width?: number;
  height?: number;
  color?: string;
}

export const Histogram = ({
  values,
  bins = 10,
  min,
  max,
  width = 560,
  height = 140,
  color = "#57ab7a",
}: HistogramProps) => {
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((v - min) / Math.max(1, max - min)) * bins)));
    counts[idx]!++;
  }
  const data = counts.map((c, i) => ({
    label: `${Math.round(min + ((i / bins) * (max - min)))}`,
    value: c,
  }));
  return <BarChart data={data} width={width} height={height} color={color} />;
};

/** Colored cell for heatmaps. */
export const HeatCell = ({ value, max }: { value: number | null; max: number }) => {
  if (value === null) return <div className="hm-cell faint">—</div>;
  const t = max > 0 ? value / max : 0;
  // red → amber → green
  const bg =
    t < 0.5
      ? `rgba(229,83,75,${0.15 + t * 0.7})`
      : t < 0.75
        ? `rgba(240,168,50,${0.15 + (t - 0.5) * 1.4})`
        : `rgba(87,171,122,${0.2 + (t - 0.75) * 1.6})`;
  return (
    <div className="hm-cell" style={{ background: bg }} title={`${value.toFixed(0)}/100`}>
      {value.toFixed(0)}
    </div>
  );
};

export const Legend = ({ items }: { items: readonly { color: string; label: string }[] }) => (
  <div className="flex wrap small dim">
    {items.map((i) => (
      <span key={i.label} className="flex">
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 2,
            background: i.color,
            display: "inline-block",
          }}
        />
        {i.label}
      </span>
    ))}
  </div>
);

export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="mt">{children}</h2>
);
