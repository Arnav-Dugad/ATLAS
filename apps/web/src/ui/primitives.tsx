import { type CSSProperties, type ReactNode, useId } from "react";
import type { Provenance } from "../lib/api";
import { hazardMeta, PROVENANCE_META, SEVERITY_LABELS, severityColor } from "../lib/hazards";
import s from "./primitives.module.css";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- hazard glyph */
export function HazardGlyph({ hazard, size = 16, color, strokeWidth = 1.8, title }: {
  hazard: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  title?: string;
}) {
  const meta = hazardMeta(hazard);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? meta.color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d={meta.glyph} />
    </svg>
  );
}

/* ---------------------------------------------------------------- severity */
export function SeverityMeter({ level, size = "md", showLabel = false }: { level: number; size?: "sm" | "md"; showLabel?: boolean }) {
  const color = severityColor(level);
  return (
    <span className={cx(s.sev, size === "sm" && s.sevSm)} title={`Severity ${level}/5 — ${SEVERITY_LABELS[level] ?? ""}`}>
      <span className={s.sevBars} aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={s.sevBar} style={{ background: i <= level ? color : undefined, height: `${4 + i * 2}px` }} />
        ))}
      </span>
      {showLabel ? (
        <span className={s.sevLabel} style={{ color }}>
          {SEVERITY_LABELS[level]}
        </span>
      ) : (
        <span className="sr-only">
          Severity {level} of 5, {SEVERITY_LABELS[level]}
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- provenance */
export function ProvenanceBadge({ kind, compact = false }: { kind: Provenance | string; compact?: boolean }) {
  const meta = PROVENANCE_META[kind as Provenance] ?? PROVENANCE_META.unavailable;
  return (
    <span
      className={s.prov}
      style={{ "--prov": meta.color } as CSSProperties}
      title={`${meta.label}: ${meta.description}`}
      aria-label={`Provenance: ${meta.label}`}
    >
      <span className={s.provDot} aria-hidden />
      {compact ? meta.short : meta.label}
    </span>
  );
}

/* ---------------------------------------------------------------- confidence */
export function ConfidenceMeter({ score, label }: { score: number; label: string }) {
  const pct = Math.round(score * 100);
  return (
    <span className={s.conf} title={`Confidence heuristic ${pct}/100 (${label}) — not a calibrated probability`}>
      <span className={s.confTrack} aria-hidden>
        <span className={s.confFill} style={{ width: `${pct}%` }} />
      </span>
      <span className={s.confLabel}>{label}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- small bits */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

export function Dot({ color, pulse = false, size = 7 }: { color: string; pulse?: boolean; size?: number }) {
  return (
    <span className={cx(s.dot, pulse && s.dotPulse)} style={{ "--c": color, width: size, height: size } as CSSProperties} aria-hidden />
  );
}

export function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className={s.sectionLabel}>
      <span className="label">{children}</span>
      {right ? <span className={s.sectionRight}>{right}</span> : null}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 12, radius = 4, style }: {
  width?: number | string;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}) {
  return <span className={s.skel} style={{ width, height, borderRadius: radius, ...style }} aria-hidden />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className={s.skelRows} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skelRow}>
          <Skeleton width={28} height={28} radius={8} />
          <div style={{ flex: 1, display: "grid", gap: 6 }}>
            <Skeleton width={`${70 - (i % 3) * 12}%`} height={11} />
            <Skeleton width={`${45 + (i % 2) * 15}%`} height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={s.empty}>
      {icon ? <div className={s.emptyIcon}>{icon}</div> : null}
      <div className={s.emptyTitle}>{title}</div>
      {children ? <div className={s.emptyBody}>{children}</div> : null}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className={cx(s.empty, s.error)} role="alert">
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptyBody}>{message}</div>
      {onRetry ? (
        <button type="button" className={s.ghostBtn} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- controls */
export function Segmented<T extends string>({ value, options, onChange, label, size = "md" }: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cx(s.seg, size === "sm" && s.segSm)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={cx(s.segBtn, o.value === value && s.segOn)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className={cx(s.toggleRow, disabled && s.disabled)} htmlFor={id}>
      <span className={s.toggleText}>
        <span className={s.toggleLabel}>{label}</span>
        {description ? <span className={s.toggleDesc}>{description}</span> : null}
      </span>
      <input id={id} type="checkbox" className={s.toggleInput} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.toggle} aria-hidden>
        <span className={s.toggleKnob} />
      </span>
    </label>
  );
}

export function IconButton({ label, onClick, children, active, shortcut, size = 32 }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  shortcut?: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={cx(s.iconBtn, active && s.iconBtnOn)}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- sparkline */
export function Sparkline({ values, width = 120, height = 28, color = "var(--accent)", fill = true, label }: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  label?: string;
}) {
  const id = useId();
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {fill ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d}L${width},${height}L0,${height}Z`} fill={`url(#${id})`} />
        </>
      ) : null}
      {/* draws itself in from the left (CSS; reduced motion turns the animation off) */}
      <path className={s.sparkLine} pathLength={1} d={d} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {Array.from(text).map((ch, i) =>
        set.has(i) ? (
          <mark key={i} className={s.mark}>
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}
