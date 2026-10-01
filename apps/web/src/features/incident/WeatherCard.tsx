import { CloudRain, Droplets, Gauge, Navigation, Thermometer, Wind } from "lucide-react";
import { LOCAL_ONLY_MESSAGE, STATIC_MODE } from "../../lib/api";
import { convert, relTime } from "../../lib/format";
import { useWeather } from "../../lib/queries";
import { ErrorState, Label, ProvenanceBadge, Skeleton, Sparkline, AsOf } from "../../ui/primitives";
import s from "./IncidentPanel.module.css";
import { useUnits } from "../../lib/settings";

export function WeatherCard({ id }: { id: string }) {
  const q = useWeather(id);
  useUnits(); // re-render when units change
  if (STATIC_MODE) return <ErrorState title="Weather context runs locally" message={LOCAL_ONLY_MESSAGE} />;
  if (q.error) {
    return <ErrorState title="Weather context unavailable" message="Open-Meteo did not respond. This does not affect incident data." onRetry={() => void q.refetch()} />;
  }
  const w = q.data;
  const cur = w?.current;
  const num = (k: string) => (typeof cur?.[k] === "number" ? (cur[k] as number) : null);
  const hourly = w?.hourly ?? {};
  const series = (k: string) => ((hourly[k] as (number | null)[] | undefined) ?? []).filter((v): v is number => typeof v === "number");
  const nowIdx = (() => {
    const times = (hourly.time as string[] | undefined) ?? [];
    const now = Date.now();
    const i = times.findIndex((t) => Date.parse(`${t}Z`) > now);
    return i < 0 ? times.length : i;
  })();

  const tUnit = convert(0, "°C").unit;
  const wUnit = convert(0, "km/h").unit;
  const tc = (v: number | null | undefined) => (v == null ? null : convert(v, "°C").value);
  const wc = (v: number | null | undefined) => (v == null ? null : convert(v, "km/h").value);
  return (
    <section className={s.weather}>
      <Label
        right={
          <>
            {w ? <AsOf at={w.fetched_at} source="Open-Meteo" label="Fetched" /> : null}
            <ProvenanceBadge kind="model" compact />
          </>
        }
      >
        Weather at the incident
      </Label>
      {!w ? (
        <div style={{ display: "grid", gap: 8 }}>
          <Skeleton height={44} />
          <Skeleton height={60} />
        </div>
      ) : (
        <>
          <div className={s.wxNow}>
            <div className={s.wxTemp}>
              <span className="num">{tc(num("temperature_2m"))?.toFixed(1) ?? "—"}</span>
              <span className={s.unit}>{tUnit}</span>
            </div>
            <div className={s.wxText}>
              <div>{cur?.weather_text ?? "—"}</div>
              <div className={s.dim}>
                feels like {tc(num("apparent_temperature"))?.toFixed(0) ?? "—"}
                {tUnit}
              </div>
            </div>
          </div>
          <div className={s.wxGrid}>
            <WxStat icon={<Wind size={13} />} label="Wind" value={`${wc(num("wind_speed_10m"))?.toFixed(0) ?? "—"} ${wUnit}`} sub={`gusts ${wc(num("wind_gusts_10m"))?.toFixed(0) ?? "—"}`} />
            <WxStat
              icon={<Navigation size={13} style={{ transform: `rotate(${(num("wind_direction_10m") ?? 0) + 180}deg)` }} />}
              label="From"
              value={`${num("wind_direction_10m")?.toFixed(0) ?? "—"}°`}
            />
            <WxStat icon={<CloudRain size={13} />} label="Precip." value={`${num("precipitation")?.toFixed(1) ?? "—"} mm`} />
            <WxStat icon={<Droplets size={13} />} label="Humidity" value={`${num("relative_humidity_2m")?.toFixed(0) ?? "—"}%`} />
            <WxStat icon={<Gauge size={13} />} label="Pressure" value={`${num("pressure_msl")?.toFixed(0) ?? "—"} hPa`} />
            <WxStat icon={<Thermometer size={13} />} label="Cloud" value={`${num("cloud_cover")?.toFixed(0) ?? "—"}%`} />
          </div>
          <div className={s.wxCharts}>
            <WxChart label={`Temperature ${tUnit}`} values={series("temperature_2m").map((v) => tc(v) ?? v)} color="#f2b84b" nowIdx={nowIdx} />
            <WxChart label="Precipitation mm" values={series("precipitation")} color="#3ea8f2" nowIdx={nowIdx} />
            <WxChart label={`Wind gusts ${wUnit}`} values={series("wind_gusts_10m").map((v) => wc(v) ?? v)} color="#9fb6cc" nowIdx={nowIdx} />
          </div>
          <p className={s.wxNote}>
            {w.model_note} Grid point {w.grid.lat.toFixed(2)}, {w.grid.lon.toFixed(2)}
            {w.grid.elevation_m != null ? ` · ${Math.round(w.grid.elevation_m)} m` : ""} · fetched {relTime(w.fetched_at)}
            {w.stale ? " (cached — source unreachable)" : ""}. {w.attribution}
          </p>
        </>
      )}
    </section>
  );
}

function WxStat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className={s.wxStat}>
      <span className={s.wxIcon}>{icon}</span>
      <span className={s.wxLabel}>{label}</span>
      <span className={s.wxValue}>{value}</span>
      {sub ? <span className={s.wxSub}>{sub}</span> : null}
    </div>
  );
}

function WxChart({ label, values, color, nowIdx }: { label: string; values: number[]; color: string; nowIdx: number }) {
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const nowPct = values.length > 1 ? Math.min(100, (nowIdx / (values.length - 1)) * 100) : 0;
  return (
    <div className={s.wxChart}>
      <div className={s.wxChartHead}>
        <span>{label}</span>
        <span className="num">
          {min.toFixed(0)}–{max.toFixed(0)}
        </span>
      </div>
      <div className={s.wxChartBody}>
        <Sparkline values={values} width={340} height={30} color={color} label={`${label}, past 24 h and next 48 h`} />
        <span className={s.wxNowLine} style={{ left: `${nowPct}%` }} aria-hidden />
      </div>
    </div>
  );
}
