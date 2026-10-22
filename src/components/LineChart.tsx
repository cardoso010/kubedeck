import { useEffect, useMemo, useRef, useState } from "react";
import type { Series } from "../api";

export interface RefLine {
  label: string;
  value: number;
  kind: "request" | "limit";
}

interface Props {
  series: Series[];
  refs?: RefLine[];
  format: (v: number) => string;
  height?: number;
  /** Fixed top of the scale (e.g. 1 for ratios); otherwise from the data and reference lines. */
  max?: number;
}

const PAD = { top: 10, right: 12, bottom: 22, left: 56 };
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

const clock = (t: number, spanSeconds: number) =>
  new Date(t * 1000).toLocaleTimeString([], spanSeconds > 36 * 3600 ? { weekday: "short", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** Time-series line chart in plain SVG, colored by the theme's chart tokens. */
export default function LineChart({ series, refs = [], format, height = 150, max }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const all = series.flatMap((s) => s.points);
  const { t0, t1, top } = useMemo(() => {
    const ts = all.map((p) => p[0]);
    const peak = Math.max(0, ...all.map((p) => p[1]), ...refs.map((r) => r.value));
    return { t0: Math.min(...ts), t1: Math.max(...ts), top: max ?? (peak > 0 ? peak * 1.15 : 1) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, refs, max]);

  // The container stays mounted while empty, so its width is measured from the start.
  if (all.length === 0) {
    return (
      <div className="chart" ref={host}>
        <div className="chart-empty" style={{ height }}>
          No samples yet
        </div>
      </div>
    );
  }

  const w = Math.max(width, 200);
  const innerW = w - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const span = Math.max(t1 - t0, 1);
  const x = (t: number) => PAD.left + ((t - t0) / span) * innerW;
  const y = (v: number) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;
  const path = (points: Series["points"]) => points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");

  // Hover snaps to the nearest sample of the longest series.
  const base = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0]);
  const hoverT = hover !== null ? base.points[hover]?.[0] : undefined;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - PAD.left) / innerW) * span;
    let best = 0;
    base.points.forEach((p, i) => Math.abs(p[0] - t) < Math.abs(base.points[best][0] - t) && (best = i));
    setHover(best);
  };

  const valueAt = (s: Series, t: number) => s.points.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a))[1];
  const tooltipLeft = hoverT !== undefined && x(hoverT) > w - 180;

  return (
    <div className="chart" ref={host}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Time series chart">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y(top * f)} y2={y(top * f)} className="chart-grid" />
            <text x={PAD.left - 8} y={y(top * f) + 4} className="chart-axis" textAnchor="end">
              {format(top * f)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={height - 6} className="chart-axis">
          {clock(t0, span)}
        </text>
        <text x={w - PAD.right} y={height - 6} className="chart-axis" textAnchor="end">
          {clock(t1, span)}
        </text>

        {refs.map((r) => (
          <g key={r.label}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y(r.value)} y2={y(r.value)} className={`chart-ref ${r.kind}`} />
            <text x={w - PAD.right - 4} y={y(r.value) - 4} className={`chart-ref-label ${r.kind}`} textAnchor="end">
              {r.label} {format(r.value)}
            </text>
          </g>
        ))}

        {series.length === 1 && series[0].points.length > 1 && (
          <path
            d={`${path(series[0].points)}L${x(series[0].points[series[0].points.length - 1][0])},${y(0)}L${x(series[0].points[0][0])},${y(0)}Z`}
            fill={COLORS[0]}
            className="chart-area"
          />
        )}
        {series.map((s, i) => (
          <path key={s.name} d={path(s.points)} stroke={COLORS[i % COLORS.length]} className="chart-line" />
        ))}
        {series.map((s, i) => s.points.length === 1 && <circle key={s.name} cx={x(s.points[0][0])} cy={y(s.points[0][1])} r={3} fill={COLORS[i % COLORS.length]} />)}

        {hoverT !== undefined && <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={PAD.top + innerH} className="chart-cursor" />}
      </svg>

      {hoverT !== undefined && (
        <div className="chart-tooltip" style={tooltipLeft ? { right: w - x(hoverT) + 8 } : { left: x(hoverT) + 8 }}>
          <div className="faint">{new Date(hoverT * 1000).toLocaleTimeString()}</div>
          {series.map((s, i) => (
            <div key={s.name} className="chart-tooltip-row">
              <span className="chart-swatch" style={{ background: COLORS[i % COLORS.length] }} />
              <span>{s.name}</span>
              <strong>{format(valueAt(s, hoverT))}</strong>
            </div>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={s.name}>
              <span className="chart-swatch" style={{ background: COLORS[i % COLORS.length] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
