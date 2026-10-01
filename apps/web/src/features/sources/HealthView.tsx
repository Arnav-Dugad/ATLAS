import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { HardDrive, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, LOCAL_ONLY_MESSAGE, STATIC_MODE } from "../../lib/api";
import { bytes, compact, duration, relTime } from "../../lib/format";
import { useLive } from "../../lib/live";
import { useHealth, useMetrics, useStorage } from "../../lib/queries";
import { useUi } from "../../lib/store";
import { cx, Dot, ErrorState, Label, Skeleton } from "../../ui/primitives";
import s from "./SourcesView.module.css";
import h from "./HealthView.module.css";

export function HealthView() {
  const health = useHealth();
  const metrics = useMetrics();
  const storage = useStorage();
  const setView = useUi((st) => st.setView);
  const live = useLive((st) => st.status);
  const fps = useFps();
  const client = useQueryClient();
  const clear = useMutation({ mutationFn: () => api.clearCache(), onSuccess: () => void client.invalidateQueries({ queryKey: ["storage"] }) });

  const latency = Object.entries(metrics.data?.summaries ?? {})
    .filter(([k]) => k.startsWith("http.latency_ms."))
    .map(([k, v]) => ({ host: k.replace("http.latency_ms.", ""), ...v }));
  const api_ = Object.entries(metrics.data?.summaries ?? {})
    .filter(([k]) => k.startsWith("api.latency_ms."))
    .map(([k, v]) => ({ route: k.replace("api.latency_ms.", ""), ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const counters = metrics.data?.counters ?? {};
  const cacheHits = Object.entries(counters)
    .filter(([k]) => k.startsWith("http.cache_hit.") || k.startsWith("http.not_modified."))
    .reduce((a, [, v]) => a + v, 0);
  const requests = Object.entries(counters)
    .filter(([k]) => k.startsWith("http.requests."))
    .reduce((a, [, v]) => a + v, 0);

  if (STATIC_MODE) {
    return (
      <motion.div className={s.page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <div className={s.inner}>
          <header className={s.head}>
            <div>
              <div className="label">Data health & observability</div>
              <h1 className={s.title}>Engine status</h1>
              <p className={s.lede}>Scheduler, job, latency and storage telemetry are measured by the local engine.</p>
            </div>
            <div className={s.summary}>
              <div className={h.badges}>
                <Badge label="Mode" ok value="snapshot" />
                <Badge label="Render" ok={fps >= 40} value={`${fps} fps`} />
              </div>
              <button type="button" className={s.back} onClick={() => setView("planet")}>
                Back to planet
              </button>
            </div>
          </header>
          <ErrorState title="Engine health runs locally" message={LOCAL_ONLY_MESSAGE} />
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div className={s.page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className={s.inner}>
        <header className={s.head}>
          <div>
            <div className="label">Data health & observability</div>
            <h1 className={s.title}>Engine status</h1>
            <p className={s.lede}>Everything here is measured locally. No telemetry leaves this machine.</p>
          </div>
          <div className={s.summary}>
            <div className={h.badges}>
              <Badge label="Engine" ok={health.data?.status === "ok"} value={health.data ? health.data.status : "offline"} />
              <Badge label="Live stream" ok={live === "live"} value={live} />
              <Badge label="Render" ok={fps >= 40} value={`${fps} fps`} />
            </div>
            <button type="button" className={s.back} onClick={() => setView("planet")}>
              Back to planet
            </button>
          </div>
        </header>

        {health.error && !health.data ? (
          <ErrorState title="Engine unreachable" message="Start the engine with `pnpm dev`." onRetry={() => void health.refetch()} />
        ) : null}

        <div className={h.grid}>
          <section className={h.card}>
            <Label right={health.data ? `uptime ${duration(health.data.uptime_s)}` : undefined}>Scheduled jobs</Label>
            {!health.data ? (
              <Skeleton height={180} />
            ) : (
              <table className={s.runs}>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Every</th>
                    <th>Last OK</th>
                    <th>Next</th>
                    <th className={s.right}>Runs</th>
                    <th className={s.right}>ms</th>
                  </tr>
                </thead>
                <tbody>
                  {health.data.jobs.map((j) => (
                    <tr key={j.name} title={j.last_error ?? undefined}>
                      <td>
                        <Dot color={j.failures ? "var(--bad)" : j.running ? "var(--accent)" : "var(--ok)"} size={5} pulse={j.running} /> {j.name}
                      </td>
                      <td className="num">{duration(j.interval_s)}</td>
                      <td>{j.last_ok ? relTime(j.last_ok) : "—"}</td>
                      <td>{j.running ? "running" : relTime(j.next_run)}</td>
                      <td className={cx(s.right, "num")}>{j.runs}</td>
                      <td className={cx(s.right, "num")}>{j.last_duration_ms != null ? Math.round(j.last_duration_ms) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={h.card}>
            <Label right={requests ? `${compact(requests)} requests · ${compact(cacheHits)} served from cache` : undefined}>Upstream latency</Label>
            <table className={s.runs}>
              <thead>
                <tr>
                  <th>Host</th>
                  <th className={s.right}>p50</th>
                  <th className={s.right}>p95</th>
                  <th className={s.right}>max</th>
                  <th className={s.right}>n</th>
                </tr>
              </thead>
              <tbody>
                {latency.map((l) => (
                  <tr key={l.host}>
                    <td>{l.host}</td>
                    <td className={cx(s.right, "num")}>{Math.round(l.p50)}</td>
                    <td className={cx(s.right, "num")}>{Math.round(l.p95)}</td>
                    <td className={cx(s.right, "num")}>{Math.round(l.max)}</td>
                    <td className={cx(s.right, "num")}>{l.count}</td>
                  </tr>
                ))}
                {latency.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No upstream requests yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section className={h.card}>
            <Label>API latency (ms)</Label>
            <table className={s.runs}>
              <thead>
                <tr>
                  <th>Route</th>
                  <th className={s.right}>p50</th>
                  <th className={s.right}>p95</th>
                  <th className={s.right}>n</th>
                </tr>
              </thead>
              <tbody>
                {api_.map((r) => (
                  <tr key={r.route}>
                    <td className={h.route}>{r.route.replace("/api/v1", "")}</td>
                    <td className={cx(s.right, "num")}>{r.p50.toFixed(1)}</td>
                    <td className={cx(s.right, "num")}>{r.p95.toFixed(1)}</td>
                    <td className={cx(s.right, "num")}>{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={h.card}>
            <Label right={<button type="button" className={h.clear} onClick={() => clear.mutate()} disabled={clear.isPending}><Trash2 size={12} /> Clear HTTP cache</button>}>Storage</Label>
            {!storage.data ? (
              <Skeleton height={160} />
            ) : (
              <div className={h.storage}>
                <div className={h.storeRow}>
                  <HardDrive size={14} /> Database <span className="num">{bytes(storage.data.database.bytes)}</span>
                </div>
                <div className={h.tables}>
                  {Object.entries(storage.data.database.tables).map(([t, n]) => (
                    <div key={t} className={h.tableRow}>
                      <span>{t}</span>
                      <span className="num">{compact(n)}</span>
                    </div>
                  ))}
                </div>
                <div className={h.storeRow}>
                  <HardDrive size={14} /> HTTP cache <span className="num">{bytes(storage.data.http_cache.bytes)}</span>
                  <span className={h.dim}>{storage.data.http_cache.entries} entries</span>
                </div>
                <div className={h.packs}>
                  {storage.data.packs.map((p) => (
                    <div key={p.id} className={h.pack}>
                      <div className={h.packName}>
                        <Dot color={p.installed ? "var(--ok)" : "var(--text-4)"} size={6} /> {p.title}
                      </div>
                      <div className={h.dim}>
                        {p.installed ? `${bytes(p.size_bytes)} · installed ${relTime(p.installed_at)}` : `~${p.approx_size_mb} MB · not installed`} · {p.license}
                      </div>
                      {!p.installed ? <code className={h.cmd}>pnpm engine packs install {p.id}</code> : null}
                    </div>
                  ))}
                </div>
                {clear.data ? <div className={h.dim}>Removed {clear.data.removed} cached responses.</div> : null}
              </div>
            )}
          </section>

          <section className={cx(h.card, h.wide)}>
            <Label right={metrics.data ? `${metrics.data.logs.length} lines` : undefined}>Engine log</Label>
            <div className={h.logs} role="log" aria-live="off">
              {(metrics.data?.logs ?? []).slice(-120).reverse().map((l, i) => (
                <div key={`${l.at}-${i}`} className={h.logLine} data-level={l.level}>
                  <span className={h.logAt}>{l.at.slice(11, 19)}</span>
                  <span className={h.logLevel}>{l.level}</span>
                  <span className={h.logName}>{l.logger.replace("atlas.", "")}</span>
                  <span className={h.logMsg}>{l.message}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </motion.div>
  );
}

function Badge({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className={h.badge}>
      <Dot color={ok ? "var(--ok)" : "var(--warn)"} pulse={ok} size={7} />
      <div>
        <div className={h.badgeLabel}>{label}</div>
        <div className={h.badgeValue}>{value}</div>
      </div>
    </div>
  );
}

/** Measures the browser's frame rate (what the user actually experiences). */
function useFps(): number {
  const [fps, setFps] = useState(0);
  const frames = useRef(0);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      frames.current += 1;
      if (t - last >= 1000) {
        setFps(Math.round((frames.current * 1000) / (t - last)));
        frames.current = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}
