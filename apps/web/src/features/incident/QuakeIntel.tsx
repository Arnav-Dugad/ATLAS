/**
 * Earthquake intelligence: the USGS's own products quoted as issued (PAGER, ShakeMap, aftershock
 * forecast, location uncertainty), where USGS and EMSC disagree, the largest earthquakes nearby
 * since 1900, and this week's activity against the ten-year rate. Nothing here is an ATLAS
 * forecast.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, History, Scale, ShieldCheck, Waves } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import { api, explainError, isLocalOnly, STATIC_MODE, type IncidentDetail, type ObservationOut, type SeismicContext, type UsgsProducts } from "../../lib/api";
import { compact, decimal, dist, int, relTime, utcFull } from "../../lib/format";
import { haversineKm } from "../../lib/measure";
import { useUnits } from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, Dot, Label, ProvenanceBadge, Skeleton } from "../../ui/primitives";
import s from "./Intel.module.css";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const MMI = [
  { color: "#ffffff", words: "Not felt" },
  { color: "#ffffff", words: "Not felt" },
  { color: "#bfccff", words: "Weak" },
  { color: "#a0e6ff", words: "Weak" },
  { color: "#80ffff", words: "Light" },
  { color: "#7aff93", words: "Moderate" },
  { color: "#ffff00", words: "Strong" },
  { color: "#ffc800", words: "Very strong" },
  { color: "#ff9100", words: "Severe" },
  { color: "#ff0000", words: "Violent" },
  { color: "#c80000", words: "Extreme" },
];
const PAGER_COLOR: Record<string, string> = { green: "#6fd3a8", yellow: "#f2c14e", orange: "#f4873c", red: "#ff4d6a" };

function pct(p: number | null): string {
  if (p == null) return "—";
  if (p < 0.01) return "<1%";
  if (p > 0.99) return ">99%";
  return `${Math.round(p * 100)}%`;
}

export function QuakeIntel({ d }: { d: IncidentDetail }) {
  useUnits();
  const usgs = useQuery({
    queryKey: ["usgs", d.id],
    queryFn: ({ signal }) => api.usgsProducts(d.id, signal),
    enabled: !STATIC_MODE,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const ctx = useQuery({
    queryKey: ["seismic-context", d.id],
    queryFn: ({ signal }) => api.seismicContext(d.id, signal),
    enabled: !STATIC_MODE,
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const products = usgs.data?.status === "ok" ? usgs.data : null;

  // ShakeMap contours and the location-uncertainty circle on the globe while this is open.
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !products) return;
    const err = products.location?.horizontal_error_km;
    g.setQuakeProducts({
      contours: products.shakemap?.contours?.features ?? [],
      uncertainty: d.lat != null && d.lon != null && err ? { lat: d.lat, lon: d.lon, km: err } : null,
    });
    return () => globeRef.current?.setQuakeProducts(null);
  }, [products, d.lat, d.lon]);

  return (
    <>
      <SourceAgreement observations={d.observations} />
      {STATIC_MODE ? (
        <section className={s.card}>
          <Label>Official USGS products</Label>
          <p className={s.note}>ShakeMap, PAGER, the USGS aftershock forecast and historical context load in the local engine.</p>
        </section>
      ) : (
        <>
          <section className={s.card}>
            <Label right={<ProvenanceBadge kind={products ? "real" : "unavailable"} compact />}>
              <span className={s.titleRow}>
                <ShieldCheck size={12} aria-hidden /> Official USGS products
              </span>
            </Label>
            {usgs.isLoading ? (
              <Skeleton height={120} />
            ) : usgs.error ? (
              <p className={s.note}>{isLocalOnly(usgs.error) ? "" : explainError(usgs.error)}</p>
            ) : usgs.data?.status === "unavailable" ? (
              <p className={s.note}>{usgs.data.reason}</p>
            ) : products ? (
              <Official p={products} />
            ) : null}
          </section>
          {products?.aftershocks ? <Aftershocks a={products.aftershocks} /> : null}
          <section className={s.card}>
            <Label right={<ProvenanceBadge kind="real" compact />}>
              <span className={s.titleRow}>
                <History size={12} aria-hidden /> Largest nearby since 1900
              </span>
            </Label>
            {ctx.isLoading ? (
              <Skeleton height={90} />
            ) : ctx.data?.analogs.status === "ok" ? (
              <Analogs a={ctx.data.analogs} from={d} />
            ) : (
              <p className={s.note}>{ctx.data?.analogs.status === "unavailable" ? ctx.data.analogs.reason : ctx.error ? explainError(ctx.error) : ""}</p>
            )}
          </section>
          <section className={s.card}>
            <Label right={<ProvenanceBadge kind={ctx.data?.activity.status === "ok" ? "derived" : "unavailable"} compact />}>
              <span className={s.titleRow}>
                <Waves size={12} aria-hidden /> Activity this week
              </span>
            </Label>
            {ctx.isLoading ? (
              <Skeleton height={60} />
            ) : ctx.data?.activity.status === "ok" ? (
              <Activity a={ctx.data.activity} />
            ) : (
              <p className={s.note}>{ctx.data?.activity.status === "unavailable" ? ctx.data.activity.reason : ""}</p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Official({ p }: { p: UsgsProducts }) {
  const pager = p.pager;
  const exposure = (pager?.exposure ?? []).filter((e) => e.population > 0 && e.mmi >= 2).sort((a, b) => b.mmi - a.mmi);
  const maxPop = Math.max(1, ...exposure.map((e) => e.population));
  const loc = p.location;
  return (
    <div className={s.official}>
      <div className={s.chips}>
        {pager?.alert_level ? (
          <span className={s.chip} title="USGS PAGER alert level for estimated losses">
            <Dot color={PAGER_COLOR[pager.alert_level] ?? "var(--text-2)"} size={8} /> PAGER {pager.alert_level}
            {pager.status ? <span className={s.dim}> · {pager.status}</span> : null}
          </span>
        ) : null}
        {p.shakemap && (p.shakemap.max_mmi ?? p.shakemap.max_contour_mmi) != null ? (
          <ShakeChip max={p.shakemap.max_mmi} contour={p.shakemap.max_contour_mmi} version={p.shakemap.version} />
        ) : null}
      </div>

      {exposure.length ? (
        <div>
          <div className={s.sub}>Residents by shaking intensity (PAGER)</div>
          <ul className={s.bars}>
            {exposure.map((e) => (
              <li key={e.mmi} className={s.barRow}>
                <span className={s.barKey}>
                  <span className={s.mmiSwatch} style={{ background: MMI[e.mmi]?.color }} />
                  {ROMAN[e.mmi]} <span className={s.dim}>{MMI[e.mmi]?.words}</span>
                </span>
                <span className={s.barTrack}>
                  <span className={s.barFill} style={{ width: `${Math.max(2, (e.population / maxPop) * 100)}%`, background: MMI[e.mmi]?.color }} />
                </span>
                <span className={s.barVal}>{compact(e.population)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : pager ? (
        <p className={s.note}>PAGER estimates no one exposed to noticeable shaking (or exposure is not yet computed).</p>
      ) : null}

      {loc ? (
        <div className={s.loc}>
          <div className={s.sub}>Location quality</div>
          <dl className={s.kv}>
            <dt>Epicentre</dt>
            <dd>{loc.horizontal_error_km != null ? `± ${dist(loc.horizontal_error_km, 1)}` : "—"}</dd>
            <dt>Depth</dt>
            <dd>{loc.depth_error_km != null ? `± ${dist(loc.depth_error_km, 1)}` : "—"}</dd>
            <dt>Stations</dt>
            <dd>{loc.stations != null ? int(loc.stations) : "—"}</dd>
            <dt>Azimuthal gap</dt>
            <dd title="Largest angle between stations seen from the epicentre; under ~180° is well constrained">{loc.azimuthal_gap_deg != null ? `${Math.round(loc.azimuthal_gap_deg)}°` : "—"}</dd>
          </dl>
          <p className={s.note}>
            {loc.status === "reviewed" ? "Reviewed by a USGS seismologist." : "Automatic solution; it may change on review."} The dashed circle on the globe is the
            horizontal uncertainty.
          </p>
        </div>
      ) : null}
      <p className={s.attr}>
        {p.attribution}.{" "}
        {p.event_url ? (
          <a href={p.event_url} target="_blank" rel="noreferrer noopener">
            USGS event page <ExternalLink size={10} aria-hidden />
          </a>
        ) : null}
        {p.errors.length ? <span className={s.dim}> · Some products could not be loaded.</span> : null}
      </p>
    </div>
  );
}

function ShakeChip({ max, contour, version }: { max: number | null; contour: number | null; version: string | null }) {
  const v = (max ?? contour) as number;
  const level = Math.max(1, Math.min(10, Math.round(v)));
  return (
    <span className={s.chip} title={max != null ? "Highest shaking intensity on the USGS ShakeMap" : "The ShakeMap does not state its maximum; this is its highest contour"}>
      <span className={s.mmiSwatch} style={{ background: MMI[level]?.color }} />
      ShakeMap {max != null ? "max" : "contours to"} {ROMAN[level]}
      {max != null ? ` (${decimal(max)})` : ""}
      <span className={s.dim}> · v{version ?? "?"}</span>
    </span>
  );
}

function Aftershocks({ a }: { a: NonNullable<UsgsProducts["aftershocks"]> }) {
  const mags = a.windows[0]?.bins.map((b) => b.magnitude) ?? [];
  return (
    <section className={s.card}>
      <Label right={<span className={s.forecastTag}>USGS forecast</span>}>Aftershock forecast</Label>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <caption className={s.sub}>Chance of at least one aftershock of magnitude…</caption>
          <thead>
            <tr>
              <th scope="col">Within</th>
              {mags.map((m) => (
                <th key={m} scope="col">
                  M{m}+
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.windows.map((w) => (
              <tr key={w.label}>
                <th scope="row">{w.label}</th>
                {w.bins.map((b) => (
                  <td
                    key={b.magnitude}
                    style={{ "--p": b.probability ?? 0 } as React.CSSProperties}
                    title={b.median != null ? `Expected number: ${b.median} (95% range ${b.p95_min}–${b.p95_max})` : undefined}
                  >
                    {pct(b.probability)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        Issued by the USGS {a.issued_at ? relTime(a.issued_at) : ""} and shown exactly as published; ATLAS does not compute aftershock forecasts.
        {a.next_forecast_at ? ` Next update ${utcFull(a.next_forecast_at)}.` : ""} Model: {a.model ?? "—"}.
      </p>
    </section>
  );
}

function Analogs({ a, from }: { a: Extract<SeismicContext["analogs"], { status: "ok" }>; from: IncidentDetail }) {
  if (!a.items.length) return <p className={s.note}>No M{a.min_magnitude}+ earthquakes within {dist(a.radius_km)} in the catalogue since 1900.</p>;
  return (
    <>
      <ul className={s.analogs}>
        {a.items.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className={s.analog}
              onClick={() => e.lat != null && e.lon != null && useUi.getState().flyTo({ lat: e.lat, lon: e.lon, height: 900_000 })}
            >
              <span className={s.analogMag}>M{decimal(e.magnitude)}</span>
              <span className={s.analogPlace}>
                {e.place ?? "—"}
                <span className={s.dim}>
                  {" "}
                  · {e.time?.slice(0, 4)}
                  {from.lat != null && from.lon != null && e.lat != null && e.lon != null ? ` · ${dist(haversineKm({ lat: from.lat, lon: from.lon }, { lat: e.lat, lon: e.lon }))} away` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className={s.note}>
        M{a.min_magnitude}+ within {dist(a.radius_km)}. {a.note}
      </p>
    </>
  );
}

function Activity({ a }: { a: Extract<SeismicContext["activity"], { status: "ok" }> }) {
  const [open, setOpen] = useState(false);
  const tone = a.verdict === "far above usual" ? "var(--danger, #ff4d6a)" : a.verdict === "above usual" ? "var(--warn)" : "var(--ok)";
  return (
    <div className={s.activity}>
      <div className={s.activityRow}>
        <span className={s.big}>{int(a.week_count)}</span>
        <span>
          M{a.min_magnitude}+ within {dist(a.radius_km)} in 7 days
          <span className={s.dim}> · usually {decimal(a.weekly_rate, 1)} a week</span>
        </span>
      </div>
      <div className={s.verdict} style={{ color: tone }}>
        <Dot color={tone} size={7} /> {a.verdict[0]!.toUpperCase() + a.verdict.slice(1)}
        {a.ratio != null && a.week_count > 0 ? <span className={s.dim}> · {decimal(a.ratio, 1)}× the {a.baseline_years}-year rate</span> : null}
        <span className={s.dim}> · p {a.p_value < 0.0001 ? "< 0.0001" : `= ${a.p_value.toFixed(a.p_value < 0.01 ? 4 : 2)}`}</span>
      </div>
      <button type="button" className={s.how} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={12} className={cx(s.chev, open && s.chevOpen)} aria-hidden /> Method
      </button>
      {open ? <p className={s.note}>{a.method}</p> : null}
    </div>
  );
}

/** Where USGS and EMSC report different magnitudes, epicentres or depths for the same event. */
function SourceAgreement({ observations }: { observations: ObservationOut[] }) {
  const pair = useMemo(() => {
    const latest = (src: string) => observations.filter((o) => o.source === src).sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))[0];
    const u = latest("usgs");
    const e = latest("emsc");
    return u && e ? { u, e } : null;
  }, [observations]);
  if (!pair) return null;
  const { u, e } = pair;
  const dMag = u.magnitude != null && e.magnitude != null ? Math.abs(u.magnitude - e.magnitude) : null;
  const dKm = u.lat != null && u.lon != null && e.lat != null && e.lon != null ? haversineKm({ lat: u.lat, lon: u.lon }, { lat: e.lat, lon: e.lon }) : null;
  const dDepth = u.depth_km != null && e.depth_km != null ? Math.abs(u.depth_km - e.depth_km) : null;
  const differ = (dMag ?? 0) >= 0.3 || (dKm ?? 0) >= 25 || (dDepth ?? 0) >= 20;
  return (
    <section className={s.card}>
      <Label right={<ProvenanceBadge kind="derived" compact />}>
        <span className={s.titleRow}>
          <Scale size={12} aria-hidden /> Source agreement
        </span>
      </Label>
      <div className={s.tableWrap}>
        <table className={cx(s.table, s.agree)}>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">USGS</th>
              <th scope="col">EMSC</th>
              <th scope="col">Difference</th>
            </tr>
          </thead>
          <tbody>
            <tr className={(dMag ?? 0) >= 0.3 ? s.off : undefined}>
              <th scope="row">Magnitude</th>
              <td>
                {decimal(u.magnitude)} <span className={s.dim}>{u.magnitude_unit}</span>
              </td>
              <td>
                {decimal(e.magnitude)} <span className={s.dim}>{e.magnitude_unit}</span>
              </td>
              <td>{dMag != null ? dMag.toFixed(1) : "—"}</td>
            </tr>
            <tr className={(dKm ?? 0) >= 25 ? s.off : undefined}>
              <th scope="row">Epicentre</th>
              <td colSpan={2} className={s.dim}>
                {dKm != null ? "apart by" : "—"}
              </td>
              <td>{dKm != null ? dist(dKm, dKm < 10 ? 1 : 0) : "—"}</td>
            </tr>
            <tr className={(dDepth ?? 0) >= 20 ? s.off : undefined}>
              <th scope="row">Depth</th>
              <td>{u.depth_km != null ? dist(u.depth_km) : "—"}</td>
              <td>{e.depth_km != null ? dist(e.depth_km) : "—"}</td>
              <td>{dDepth != null ? dist(dDepth) : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        {differ
          ? "The agencies disagree noticeably. Early solutions often differ; magnitude types (e.g. Mww vs mb) also measure different things. Both values are shown, neither is preferred."
          : "USGS and EMSC broadly agree (within 0.3 magnitude units, 25 km and 20 km depth)."}
      </p>
    </section>
  );
}
