import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Columns2, Copy, Crosshair, Download, ExternalLink, FileJson, Info, Map as MapIcon, ShieldAlert, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { IncidentDetail, Metric } from "../../lib/api";
import { compareIncident } from "../../lib/compare";
import { exportBrief, exportGeoJson, exportJson } from "../../lib/export";
import { focusIncident } from "../../lib/focus";
import { coord, metricValue, observedAgo, relTime, titleCase, utcFull, utcShort } from "../../lib/format";
import { hazardMeta, PROVENANCE_META, severityColor, sourceLabel } from "../../lib/hazards";
import { useIncident } from "../../lib/queries";
import { useUi } from "../../lib/store";
import { ConfidenceMeter, cx, Dot, ErrorState, HazardGlyph, Label, ProvenanceBadge, SeverityMeter, Skeleton } from "../../ui/primitives";
import { Chronology } from "./Chronology";
import { ExposureTab } from "./ExposureTab";
import { SatelliteTab } from "./SatelliteTab";
import { SourceDrawer } from "./SourceDrawer";
import { WeatherCard } from "./WeatherCard";
import { TrackChart } from "./TrackChart";
import s from "./IncidentPanel.module.css";

type Tab = "brief" | "exposure" | "satellite" | "timeline" | "sources" | "context";

export function IncidentPanel({ id }: { id: string }) {
  const q = useIncident(id);
  const select = useUi((st) => st.select);
  const [tab, setTab] = useState<Tab>("brief");
  const d = q.data;

  if (q.error && !d) {
    return (
      <div className={s.wrap}>
        <PanelClose onClose={() => select(null)} />
        <ErrorState title="Incident unavailable" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  if (!d) return <PanelSkeleton onClose={() => select(null)} />;

  const hz = hazardMeta(d.hazard);
  return (
    <motion.div
      key={d.id}
      className={s.wrap}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      style={{ "--hz": hz.color } as React.CSSProperties}
    >
      <header className={s.head}>
        <div className={s.kicker}>
          <span className={s.kickerGlyph}>
            <HazardGlyph hazard={d.hazard} size={14} />
          </span>
          <span className={s.kickerText}>{hz.label}</span>
          <StatusPill status={d.status} />
          <span className={s.spacer} />
          <PanelClose onClose={() => select(null)} inline />
        </div>
        <h1 className={s.title}>{d.title}</h1>
        <div className={s.where}>
          {d.place ? <span>{d.place.description}</span> : null}
          {d.place?.admin1 ? <span className={s.dim}> · {d.place.admin1}</span> : null}
          {d.place?.offshore_km ? <span className={s.dim}> · offshore ~{Math.round(d.place.offshore_km)} km</span> : null}
        </div>
        <div className={s.facts}>
          <Fact label="Onset" value={utcShort(d.started_at)} hint={relTime(d.started_at)} />
          <Fact label="Latest data" value={utcShort(d.last_observation_at)} hint={observedAgo(d.last_observation_at)} />
          <Fact label="Position" value={coord(d.lat, d.lon)} mono />
        </div>
        <div className={s.actions}>
          <button type="button" className={s.action} onClick={() => focusIncident(d, { select: false })}>
            <Crosshair size={13} /> Fly to
          </button>
          <button type="button" className={s.action} onClick={() => compareIncident(d)} title="Swipe between satellite views from before onset and the latest day">
            <Columns2 size={13} /> Before / after
          </button>
          <ExportMenu d={d} />
          <CopyId id={d.id} />
        </div>
      </header>

      <div className={s.assess}>
        <div className={s.assessCell}>
          <div className="label">Severity</div>
          <div className={s.assessRow}>
            <SeverityMeter level={d.severity.level} showLabel />
          </div>
          <Explain>{d.severity.basis}. ATLAS Severity Scale v1 — an ordinal intensity scale, not an impact estimate.</Explain>
        </div>
        <div className={s.assessCell}>
          <div className="label">Confidence</div>
          <div className={s.assessRow}>
            <ConfidenceMeter score={d.confidence.score} label={d.confidence.label} />
          </div>
          <Explain>
            <ul className={s.confList}>
              {d.confidence.components.map((c) => (
                <li key={c.name}>
                  <span className="num">{Math.round(c.score * 100)}</span> {c.name} — {c.detail}
                </li>
              ))}
            </ul>
            {d.confidence.note}
          </Explain>
        </div>
      </div>

      <div className={s.tabs} role="tablist" aria-label="Incident sections">
        {(
          [
            ["brief", "Intelligence"],
            ["exposure", "Exposure"],
            ["satellite", "Satellite"],
            ["timeline", `Chronology · ${d.changes.length}`],
            ["sources", `Sources · ${d.citations.filter((c) => c.source_id !== "natural-earth").length}`],
            ["context", "Context"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx(s.tab, tab === k && s.tabOn)} onClick={() => setTab(k)}>
            {label}
            {tab === k ? <motion.span layoutId="tab-ink" className={s.tabInk} transition={{ type: "spring", stiffness: 500, damping: 40 }} /> : null}
          </button>
        ))}
      </div>

      <div className={s.body}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.14 }}>
            {tab === "brief" ? <BriefTab d={d} /> : null}
            {tab === "exposure" ? <ExposureTab d={d} /> : null}
            {tab === "satellite" ? <SatelliteTab d={d} /> : null}
            {tab === "timeline" ? <Chronology d={d} /> : null}
            {tab === "sources" ? <SourceDrawer d={d} /> : null}
            {tab === "context" ? <ContextTab d={d} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function BriefTab({ d }: { d: IncidentDetail }) {
  return (
    <div className={s.stack}>
      <section>
        <Label right={<span className={s.legendHint}>hover a badge for provenance</span>}>Key observations</Label>
        <div className={s.metrics}>
          {d.headline.length ? d.headline.map((m) => <MetricTile key={`${m.key}-${m.source}`} m={m} />) : <div className={s.dim}>No quantitative observations available for this incident.</div>}
        </div>
      </section>

      {d.track.length > 1 ? (
        <section>
          <Label>Track & intensity</Label>
          <TrackChart track={d.track as unknown as TrackPointLike[]} />
        </section>
      ) : null}

      <section className={s.official}>
        <div className={s.officialHead}>
          <ShieldAlert size={14} aria-hidden /> Official sources
        </div>
        <ul className={s.linkList}>
          {d.official_links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer noopener" className={s.linkRow}>
                <span>
                  <span className={s.linkLabel}>{l.label}</span>
                  <span className={s.linkAuth}>{l.authority}</span>
                </span>
                <ExternalLink size={13} aria-hidden />
              </a>
            </li>
          ))}
        </ul>
        <p className={s.officialNote}>ATLAS is a research tool, not an alerting service. Always follow official warnings and local authorities.</p>
      </section>

      {d.related.length ? (
        <section>
          <Label right={`${d.related.length}`}>Related incidents</Label>
          <ul className={s.related}>
            {d.related.slice(0, 8).map((r) => (
              <li key={r.id}>
                <button type="button" className={s.relatedRow} onClick={() => focusIncident({ id: r.id, hazard: r.hazard, lat: null, lon: null, bbox: null })}>
                  <HazardGlyph hazard={r.hazard} size={13} />
                  <span className={s.relatedTitle}>{r.title}</span>
                  <span className={s.relatedMeta}>
                    {r.relation !== "nearby" ? <span className={s.relTag}>{r.relation}</span> : null}
                    <span className="num">{Math.round(r.distance_km)} km</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <Label>Limitations</Label>
        <ul className={s.limits}>
          {d.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ContextTab({ d }: { d: IncidentDetail }) {
  return (
    <div className={s.stack}>
      <WeatherCard id={d.id} />
      <section>
        <Label right="Natural Earth · derived">Nearby places</Label>
        <ul className={s.places}>
          {d.nearby_places.map((p) => (
            <li key={`${p.name}-${p.lat}`} className={s.place}>
              <span className={s.placeName}>
                {p.name}
                <span className={s.dim}> · {p.country}</span>
              </span>
              <span className={s.placeMeta}>
                {p.population ? <span className={s.dim}>{Intl.NumberFormat("en", { notation: "compact" }).format(p.population)} pop.</span> : null}
                <span className="num">
                  {Math.round(p.distance_km)} km {p.compass}
                </span>
              </span>
            </li>
          ))}
          {d.nearby_places.length === 0 ? <li className={s.dim}>No populated places in the Natural Earth gazetteer within 500 km.</li> : null}
        </ul>
      </section>
    </div>
  );
}

export interface TrackPointLike {
  time: string;
  lat: number;
  lon: number;
  wind_kt?: number | null;
  pressure_mb?: number | null;
  category?: string | null;
  kind?: "observed" | "forecast";
  source?: string | null;
}

function MetricTile({ m }: { m: Metric }) {
  const prov = PROVENANCE_META[m.provenance as keyof typeof PROVENANCE_META];
  return (
    <div className={s.metric} title={[m.method, m.note].filter(Boolean).join(" — ") || undefined}>
      <div className={s.metricLabel}>{m.label}</div>
      <div className={s.metricValue}>
        <MetricValue m={m} />
      </div>
      <div className={s.metricFoot}>
        <ProvenanceBadge kind={m.provenance} compact />
        <span className={s.metricSrc}>{m.source ? sourceLabel(m.source) : "—"}</span>
      </div>
      {prov && (m.method || m.note) ? (
        <div className={s.metricInfo} aria-hidden>
          <Info size={11} />
        </div>
      ) : null}
    </div>
  );
}

function MetricValue({ m }: { m: Metric }) {
  if (m.key === "magnitude" && typeof m.value === "number") {
    return (
      <>
        <span className="num">{m.value.toFixed(1)}</span>
        <span className={s.unit}>{m.unit ?? "M"}</span>
      </>
    );
  }
  if ((m.key === "pager" || m.key === "gdacs_alert") && typeof m.value === "string") {
    const color = { GREEN: "#6fd3a8", YELLOW: "#f2c14e", ORANGE: "#f4873c", RED: "#ff4d6a" }[m.value] ?? "var(--text-1)";
    return (
      <span className={s.alertVal}>
        <Dot color={color} size={8} />
        {titleCase(m.value.toLowerCase())}
      </span>
    );
  }
  if (typeof m.value === "number") {
    const v = metricValue(m.value);
    return (
      <>
        <span className="num">{v}</span>
        {m.unit ? <span className={s.unit}>{m.unit}</span> : null}
      </>
    );
  }
  return <span>{metricValue(m.value, m.unit)}</span>;
}

function Fact({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className={s.fact}>
      <div className={s.factLabel}>{label}</div>
      <div className={cx(s.factValue, mono && "num")}>{value}</div>
      {hint ? <div className={s.factHint}>{hint}</div> : null}
    </div>
  );
}

function Explain({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.explain}>
      <button type="button" className={s.explainBtn} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={12} className={cx(s.chev, open && s.chevOpen)} aria-hidden /> How is this determined?
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div className={s.explainBody} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className={s.explainInner}>{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color = status === "active" ? "var(--ok)" : status === "monitoring" ? "var(--warn)" : "var(--text-3)";
  return (
    <span className={s.status}>
      <Dot color={color} size={6} pulse={status === "active"} />
      {status}
    </span>
  );
}

function PanelClose({ onClose, inline }: { onClose: () => void; inline?: boolean }) {
  return (
    <button type="button" className={cx(s.close, inline && s.closeInline)} onClick={onClose} aria-label="Close incident (Esc)" title="Close (Esc)">
      <X size={15} />
    </button>
  );
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={s.action}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      title="Copy ATLAS incident ID"
    >
      {done ? <Check size={13} /> : <Copy size={13} />} <span className="num">{id}</span>
    </button>
  );
}

function ExportMenu({ d }: { d: IncidentDetail }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(
    () => [
      { label: "Incident brief (Markdown)", icon: Download, run: () => exportBrief(d) },
      { label: "Full record (JSON)", icon: FileJson, run: () => exportJson(d) },
      { label: "Geometry (GeoJSON)", icon: MapIcon, run: () => exportGeoJson(d) },
    ],
    [d],
  );
  return (
    <div className={s.menuWrap}>
      <button type="button" className={s.action} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <Download size={13} /> Export
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div className={s.menu} role="menu" initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.12 }}>
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={s.menuItem}
                onClick={() => {
                  it.run();
                  setOpen(false);
                }}
              >
                <it.icon size={13} /> {it.label}
              </button>
            ))}
            <div className={s.menuNote}>Exports include provenance and source attribution.</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PanelSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <div className={s.wrap} aria-busy="true">
      <header className={s.head}>
        <div className={s.kicker}>
          <Skeleton width={120} height={12} />
          <span className={s.spacer} />
          <PanelClose onClose={onClose} inline />
        </div>
        <Skeleton width="92%" height={22} style={{ marginTop: 10 }} />
        <Skeleton width="60%" height={13} style={{ marginTop: 10 }} />
        <div className={s.facts} style={{ marginTop: 16 }}>
          <Skeleton height={34} />
          <Skeleton height={34} />
          <Skeleton height={34} />
        </div>
      </header>
      <div style={{ padding: 16, display: "grid", gap: 10 }}>
        <Skeleton height={60} />
        <Skeleton height={60} />
        <Skeleton height={120} />
      </div>
    </div>
  );
}

export { severityColor, utcFull };
