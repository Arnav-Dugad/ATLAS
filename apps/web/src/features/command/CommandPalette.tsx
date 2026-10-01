import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Accessibility,
  Activity,
  ArrowRight,
  Clock,
  Contrast,
  CornerDownLeft,
  Database,
  Download,
  Globe2,
  History,
  Layers,
  MapPin,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { globeRef } from "../../globe/ref";
import { OVERLAYS } from "../../globe/imagery";
import { api, type IncidentSummary, type SearchResponse } from "../../lib/api";
import { exportBrief } from "../../lib/export";
import { focusIncident, focusPoint } from "../../lib/focus";
import { compact, relTime, utcDate } from "../../lib/format";
import { fuzzy } from "../../lib/fuzzy";
import { HAZARDS, hazardMeta, type HazardId } from "../../lib/hazards";
import { startHistoricalReplay, useHistoricalCatalog } from "../../lib/history";
import { useUi, type LayerId, type TimeWindow } from "../../lib/store";
import { cx, HazardGlyph, Highlight, Kbd, SeverityMeter } from "../../ui/primitives";
import s from "./CommandPalette.module.css";

interface Item {
  id: string;
  section: string;
  label: string;
  hint?: ReactNode;
  icon: ReactNode;
  keywords?: string;
  indices?: number[];
  score: number;
  run: () => void;
}

const LAYER_LABELS: Partial<Record<LayerId, string>> = {
  incidents: "Incident markers",
  earthquakes: "Earthquakes (USGS)",
  fires: "Fire detections (FIRMS)",
  fireClusters: "Fire clusters",
  cyclones: "Cyclone tracks & cones",
  borders: "Country borders",
  nightLights: "Night lights",
  lighting: "Day/night lighting",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette({ incidents }: { incidents: IncidentSummary[] }) {
  const open = useUi((st) => st.paletteOpen);
  const seed = useUi((st) => st.paletteSeed);
  const close = useUi((st) => st.closePalette);
  return (
    <AnimatePresence>
      {open ? <PaletteBody key="palette" incidents={incidents} seed={seed} onClose={close} /> : null}
    </AnimatePresence>
  );
}

function PaletteBody({ incidents, seed, onClose }: { incidents: IncidentSummary[]; seed: string; onClose: () => void }) {
  const [q, setQ] = useState(seed);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 220);
  const ui = useUi();
  const catalog = useHistoricalCatalog();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const search = useQuery<SearchResponse>({
    queryKey: ["search", dq],
    queryFn: ({ signal }) => api.search(dq, signal),
    enabled: dq.length >= 2,
    staleTime: 60_000,
  });

  const commands = useMemo<Omit<Item, "score">[]>(() => {
    const done = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const out: Omit<Item, "score">[] = [
      { id: "home", section: "Navigate", label: "Reset view to whole planet", icon: <Globe2 size={15} />, keywords: "home earth globe zoom out", run: done(() => globeRef.current?.home()) },
      { id: "v-planet", section: "Navigate", label: "Open Planet view", icon: <Globe2 size={15} />, hint: "Alt 1", run: done(() => ui.setView("planet")) },
      { id: "v-sources", section: "Navigate", label: "Open Data Source Registry", icon: <Database size={15} />, hint: "Alt 2", keywords: "sources licences attribution provenance", run: done(() => ui.setView("sources")) },
      { id: "v-health", section: "Navigate", label: "Open Data Health & Observability", icon: <Activity size={15} />, hint: "Alt 3", keywords: "status metrics logs storage", run: done(() => ui.setView("health")) },
      { id: "spin", section: "View", label: ui.autoRotate ? "Stop planet rotation" : "Start planet rotation", icon: <RotateCw size={15} />, keywords: "spin rotate idle", run: done(() => ui.setAutoRotate(!ui.autoRotate)) },
      { id: "motion", section: "Accessibility", label: ui.reducedMotion ? "Enable motion" : "Reduce motion", icon: <Accessibility size={15} />, keywords: "animation a11y", run: done(() => ui.setReducedMotion(!ui.reducedMotion)) },
      { id: "contrast", section: "Accessibility", label: ui.highContrast ? "Standard contrast" : "High contrast", icon: <Contrast size={15} />, keywords: "a11y readability", run: done(() => ui.setHighContrast(!ui.highContrast)) },
      { id: "intro", section: "Help", label: "Replay the introduction", icon: <Sparkles size={15} />, keywords: "onboarding tour help", run: done(() => ui.resetIntro()) },
      { id: "refresh", section: "Data", label: "Refresh all live sources now", icon: <RefreshCw size={15} />, keywords: "sync update poll", run: done(() => ["usgs", "gdacs", "nhc", "eonet", "firms", "gvp"].forEach((id) => void api.syncSource(id).catch(() => undefined))) },
    ];
    for (const h of ["earthquake", "tropical_cyclone", "wildfire", "flood", "volcano", "drought"] as HazardId[]) {
      const meta = HAZARDS[h];
      out.push({
        id: `hz-${h}`,
        section: "Filter",
        label: `Show only ${meta.plural.toLowerCase()}`,
        icon: <HazardGlyph hazard={h} size={15} />,
        keywords: `${meta.label} active filter`,
        run: done(() => ui.setHazards([h])),
      });
    }
    out.push({ id: "hz-all", section: "Filter", label: "Show all hazards", icon: <Layers size={15} />, run: done(() => ui.setHazards([])) });
    for (const [w, label] of [["1h", "last hour"], ["24h", "last 24 hours"], ["7d", "last 7 days"], ["30d", "last 30 days"]] as [TimeWindow, string][]) {
      out.push({ id: `win-${w}`, section: "Time", label: `Time window: ${label}`, icon: <Clock size={15} />, keywords: "timeline period range", run: done(() => ui.setWindow(w)) });
    }
    for (const [id, label] of Object.entries(LAYER_LABELS) as [LayerId, string][]) {
      out.push({ id: `layer-${id}`, section: "Layers", label: `${ui.layers[id] ? "Hide" : "Show"} ${label}`, icon: <Layers size={15} />, keywords: "toggle layer", run: done(() => ui.toggleLayer(id)) });
    }
    for (const def of OVERLAYS) {
      const id = def.id as LayerId;
      out.push({ id: `ov-${id}`, section: "Layers", label: `${ui.layers[id] ? "Hide" : "Show"} ${def.title}`, icon: <Layers size={15} />, keywords: `satellite imagery overlay ${def.group}`, run: done(() => ui.toggleLayer(id)) });
    }
    for (const ev of catalog.data?.events ?? []) {
      out.push({
        id: `hist-${ev.id}`,
        section: "Historical replays",
        label: `Replay ${ev.name} · M${ev.magnitude.toFixed(1)}`,
        icon: <History size={15} />,
        hint: `${ev.sequence.count} events · ${new Date(ev.time).getUTCFullYear()}`,
        keywords: `${ev.title} demo history aftershocks sequence earthquake`,
        run: done(() => startHistoricalReplay(ev)),
      });
    }
    const sel = ui.selectedId;
    if (sel) {
      out.push({
        id: "export-brief",
        section: "Incident",
        label: "Export brief for the selected incident",
        icon: <Download size={15} />,
        keywords: "report markdown download",
        run: done(() => void api.incident(sel).then(exportBrief)),
      });
    }
    return out;
  }, [ui, onClose, catalog.data]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim();
    const res: Item[] = [];
    for (const c of commands) {
      const m = query ? (fuzzy(query, c.label) ?? (c.keywords ? fuzzy(query, c.keywords) : null)) : { score: 1, indices: [] };
      if (m) res.push({ ...c, score: m.score + (query ? 0 : 0), indices: fuzzy(query, c.label)?.indices ?? [] });
    }
    if (query) {
      for (const inc of incidents) {
        const m = fuzzy(query, inc.title) ?? fuzzy(query, `${inc.country_name ?? ""} ${inc.hazard_label} ${inc.id}`);
        if (m && m.score > 6) {
          res.push({
            id: `inc-${inc.id}`,
            section: "Incidents",
            label: inc.title,
            indices: fuzzy(query, inc.title)?.indices ?? [],
            icon: <HazardGlyph hazard={inc.hazard} size={15} />,
            hint: <SeverityMeter level={inc.severity.level} size="sm" />,
            score: m.score + 4 + inc.severity.level,
            run: () => {
              focusIncident(inc);
              onClose();
            },
          });
        }
      }
    }
    const data = search.data;
    if (query && data && data.query === dq) {
      for (const c of data.countries) {
        res.push({
          id: `ct-${c.iso3}`,
          section: "Places",
          label: `Go to ${c.name}`,
          icon: <MapPin size={15} />,
          hint: "Country",
          score: 60,
          run: () => {
            useUi.getState().flyTo({ lat: c.lat, lon: c.lon, height: 3_000_000, bbox: c.bbox });
            onClose();
          },
        });
      }
      data.places.forEach((p, i) => {
        res.push({
          id: `pl-${p.name}-${p.lat}`,
          section: "Places",
          label: `Go to ${p.name}`,
          icon: <MapPin size={15} />,
          hint: `${[p.admin1, p.country].filter(Boolean).join(", ")}${p.population ? ` · ${compact(p.population)}` : ""}`,
          score: 55 - i,
          run: () => {
            focusPoint(p.lat, p.lon, 350_000);
            onClose();
          },
        });
      });
      for (const src of data.sources) {
        res.push({
          id: `src-${src.id}`,
          section: "Sources",
          label: src.name,
          icon: <Database size={15} />,
          hint: src.provider,
          score: 40,
          run: () => {
            useUi.getState().setView("sources");
            onClose();
          },
        });
      }
    }
    const sectionOrder = ["Ask", "Incidents", "Places", "Navigate", "Historical replays", "Filter", "Time", "Layers", "Incident", "Data", "View", "Sources", "Accessibility", "Help"];
    res.sort((a, b) => (query ? b.score - a.score : sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section)));
    return res.slice(0, query ? 40 : 18);
  }, [commands, incidents, q, dq, search.data, onClose]);

  const structured = search.data?.query === dq ? search.data.structured : null;
  const showStructured = Boolean(structured?.parsed.structured) && dq.split(/\s+/).length >= 2;

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    // Scroll only the list (scrollIntoView would also scroll ancestors).
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    if (list && row) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 8;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 8;
    }
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[cursor]?.run();
    }
  };

  let lastSection = "";
  return (
    <motion.div className={s.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onMouseDown={onClose}>
      <motion.div
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 520, damping: 38 }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className={s.inputRow}>
          <Search size={16} className={s.inputIcon} aria-hidden />
          <input
            ref={input}
            className={s.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or ask: “earthquakes above M6 in Japan during 2024”"
            aria-label="Search places, incidents and commands"
            aria-controls="palette-list"
            aria-activedescendant={items[cursor] ? `pal-${cursor}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {search.isFetching ? <span className={s.spinner} aria-label="Searching" /> : null}
          <Kbd>Esc</Kbd>
        </div>

        {showStructured && structured ? (
          <div className={s.structured}>
            <div className={s.interp}>
              <span className="label">Interpreted as</span>
              <div className={s.chips}>
                {structured.parsed.chips.map((c) => (
                  <span key={c} className={s.chip}>
                    {c}
                  </span>
                ))}
              </div>
            </div>
            {structured.parsed.unsupported.map((u) => (
              <div key={u} className={s.unsupported}>
                {u}
              </div>
            ))}
            {structured.results.length ? (
              <div className={s.sResults}>
                {structured.results.slice(0, 6).map((r) => (
                  <button key={r.id} type="button" className={s.sRow} onClick={() => { focusIncident(r); onClose(); }}>
                    <HazardGlyph hazard={r.hazard} size={14} />
                    <span className={s.sTitle}>{r.title}</span>
                    <span className={s.sMeta}>{relTime(r.last_observation_at)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {structured.archive?.status === "ok" ? (
              <div className={s.archive}>
                <div className={s.archiveHead}>
                  <History size={13} /> USGS archive · {structured.archive.count} events
                  {structured.archive.from_cache ? <span className={s.cached}>cached</span> : null}
                </div>
                {(structured.archive.events ?? []).slice(0, 8).map((ev) => (
                  <button key={ev.id} type="button" className={s.sRow} onClick={() => { focusPoint(ev.lat, ev.lon, 1_200_000); onClose(); }}>
                    <HazardGlyph hazard="earthquake" size={14} />
                    <span className={s.sTitle}>{ev.title}</span>
                    <span className={s.sMeta}>{utcDate(ev.time)}</span>
                  </button>
                ))}
                <div className={s.archiveNote}>{structured.archive.attribution}. Historical events open on the globe; they are not live incidents.</div>
              </div>
            ) : null}
            {structured.results.length === 0 && !structured.archive ? <div className={s.unsupported}>No incidents in ATLAS's current window match this query.</div> : null}
          </div>
        ) : null}

        <div className={s.list} id="palette-list" role="listbox" ref={listRef}>
          {items.map((it, i) => {
            const header = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.id}>
                {header && !q.trim() ? <div className={s.section}>{header}</div> : null}
                <button
                  type="button"
                  id={`pal-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === cursor}
                  className={cx(s.item, i === cursor && s.itemOn)}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => it.run()}
                >
                  <span className={s.itemIcon}>{it.icon}</span>
                  <span className={s.itemLabel}>
                    <Highlight text={it.label} indices={it.indices ?? []} />
                  </span>
                  {it.hint ? <span className={s.itemHint}>{it.hint}</span> : null}
                  {q.trim() ? <span className={s.itemSection}>{it.section}</span> : null}
                  {i === cursor ? <CornerDownLeft size={13} className={s.enter} aria-hidden /> : null}
                </button>
              </div>
            );
          })}
          {items.length === 0 && !showStructured ? (
            <div className={s.none}>{search.isFetching ? "Searching…" : "No matches. Try a place name, an incident, or a question."}</div>
          ) : null}
        </div>
        <footer className={s.foot}>
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span className={s.footRight}>
            Queries are parsed locally — no AI involved <ArrowRight size={11} /> <span style={{ color: hazardMeta("earthquake").color }}>deterministic</span>
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
}
