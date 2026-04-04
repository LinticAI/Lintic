import { motion } from 'framer-motion';
import { type ReviewMetric, formatMetricScore } from '../lib/review-replay.js';

interface SpiderChartProps {
  metrics: ReviewMetric[];
  size?: number;
}

export function SpiderChart({ metrics, size = 160 }: SpiderChartProps) {
  const center = size / 2;
  const radius = (size / 2) * 0.72;
  const angleStep = (Math.PI * 2) / metrics.length;

  const getCoords = (angle: number, value: number) => ({
    x: center + radius * value * Math.cos(angle - Math.PI / 2),
    y: center + radius * value * Math.sin(angle - Math.PI / 2),
  });

  const points = metrics.map((m, i) => getCoords(i * angleStep, m.score));
  const polygonPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  return (
    <div className="flex flex-col gap-3">
      {/* Chart — no labels in SVG */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
      >
        {gridLevels.map((level) => {
          const pts = metrics.map((_, i) => {
            const { x, y } = getCoords(i * angleStep, level);
            return `${x},${y}`;
          });
          return (
            <polygon
              key={level}
              points={pts.join(' ')}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
          );
        })}

        {metrics.map((_, i) => {
          const { x, y } = getCoords(i * angleStep, 1);
          return (
            <line
              key={i}
              x1={center} y1={center}
              x2={x} y2={y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
          );
        })}

        <motion.path
          d={polygonPath}
          fill="var(--color-brand)"
          fillOpacity="0.15"
          stroke="var(--color-brand)"
          strokeWidth="1.5"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />

        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="var(--color-brand)" />
        ))}
      </svg>

      {/* Legend — axis labels below chart, not inside SVG */}
      <div className="flex flex-col gap-1">
        {metrics.map((metric, i) => (
          <div key={metric.name} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <div
                className="h-1 w-1 shrink-0 rounded-full"
                style={{ background: 'var(--color-brand)' }}
              />
              <span className="truncate text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-dim)' }}>
                {metric.label}
              </span>
            </div>
            <span className="shrink-0 text-[11px] font-semibold tabular-nums" style={{ color: 'var(--color-text-main)' }}>
              {formatMetricScore(metric.score)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
