/**
 * Burn-scar gallery: every Sentinel-2 dNBR map ATLAS has computed, largest burned area first.
 * The engine maps the largest active wildfires automatically every few hours; each card is the
 * same DERIVED analysis as the Satellite tab, with its dates and clear-sky share.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Flame, Globe2 } from "lucide-react";
import { api, apiUrl, isLocalOnly, STATIC_MODE, type BurnScar } from "../../lib/api";
import { convert, int, utcShort } from "../../lib/format";
import { useUnits } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, EmptyState, ErrorState, ProvenanceBadge, SeverityMeter, Skeleton } from "../../ui/primitives";
import page from "../sources/SourcesView.module.css";
import s from "./GalleryView.module.css";

function area(km2: number): string {
  const a = convert(km2, "km²");
  return `${a.value < 10 ? a.value.toFixed(2) : int(Math.round(a.value))} ${a.unit}`;
}

export function GalleryView() {
  useUnits();
  const q = useQuery({ queryKey: ["burn-scars"], queryFn: ({ signal }) => api.burnScars(signal), enabled: !STATIC_MODE, staleTime: 5 * 60_000 });
  const items = q.data?.items ?? [];
  return (
    <motion.div className={page.page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <div className={cx(page.inner, s.inner)}>
        <header className={page.head}>
          <div>
            <span className="label">Burn-scar gallery</span>
            <h1 className={page.title}>{items.length ? `${items.length} burn-scar maps` : "Burn scars"}</h1>
            <p className={page.lede}>
              Sentinel-2 burn severity (dNBR) for the largest wildfires, mapped from a clear pass before each fire and the clearest since.
              {q.data?.automatic ? " The engine maps the largest active fires automatically every 6 hours, a few at a time." : ""} Derived from
              reflectance, not field-validated.
            </p>
          </div>
          <ProvenanceBadge kind="derived" />
        </header>
        {STATIC_MODE ? (
          <EmptyState title="Runs in the local engine">Burn-scar maps read Sentinel-2 imagery on demand, so the gallery is part of the local app.</EmptyState>
        ) : q.error ? (
          isLocalOnly(q.error) ? null : <ErrorState title="Gallery unavailable" error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className={s.grid}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={280} radius={14} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="No burn-scar maps yet" icon={<Flame size={18} />}>
            The first maps appear about 10 minutes after the engine starts, once clear Sentinel-2 views exist. You can also open any wildfire → Satellite → Analyse.
          </EmptyState>
        ) : (
          <div className={s.grid}>
            {items.map((it, i) => (
              <Card key={it.incident_id} it={it} i={i} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Card({ it, i }: { it: BurnScar; i: number }) {
  const show = () => {
    const ui = useUi.getState();
    ui.setView("planet");
    ui.select(it.incident_id);
    if (it.bbox && it.images?.["change.png"]) {
      const [w, south, e, n] = it.bbox;
      ui.setRasterOverlay({ incidentId: it.incident_id, url: apiUrl(it.images["change.png"]), bbox: it.bbox, label: `Burn severity · ${it.title}` });
      ui.flyTo({ lat: (south + n) / 2, lon: (w + e) / 2, height: Math.max(25_000, (n - south) * 110_574 * 2.4), bbox: null });
    }
  };
  const burned = (it.classes ?? []).filter((c) => c.area_km2 > 0 && c.color !== "#000000" && !c.key.startsWith("regrowth") && c.key !== "unburned");
  const total = burned.reduce((a, c) => a + c.area_km2, 0) || 1;
  return (
    <motion.button
      type="button"
      className={s.card}
      onClick={show}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.04, type: "spring", stiffness: 320, damping: 30 }}
    >
      <span className={s.media}>
        {it.images ? (
          <>
            <img src={apiUrl(it.images["after.jpg"])} alt="" loading="lazy" draggable={false} />
            <img className={s.overlay} src={apiUrl(it.images["change.png"])} alt="" loading="lazy" draggable={false} />
          </>
        ) : null}
        <span className={s.badge}>
          <Globe2 size={12} /> Show on globe
        </span>
      </span>
      <span className={s.body}>
        <span className={s.title}>{it.title}</span>
        <span className={s.value}>
          {it.headline ? area(it.headline.value) : "—"} <span className={s.dim}>burned (dNBR ≥ 0.10)</span>
        </span>
        <span className={s.severity} aria-label="Burn severity mix">
          {burned.map((c) => (
            <span key={c.key} style={{ flexGrow: c.area_km2 / total, background: c.color }} title={`${c.label}: ${area(c.area_km2)}`} />
          ))}
        </span>
        <span className={s.meta}>
          <SeverityMeter level={it.severity} size="sm" />
          <span>
            {it.before ? utcShort(it.before).slice(0, 6) : "?"} → {it.after ? utcShort(it.after).slice(0, 6) : "?"}
          </span>
          {it.valid_fraction != null ? <span className={s.dim}>{Math.round(it.valid_fraction * 100)}% clear</span> : null}
        </span>
      </span>
    </motion.button>
  );
}
