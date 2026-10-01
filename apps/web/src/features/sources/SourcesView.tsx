import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, KeyRound, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { api, type SourceStatus } from "../../lib/api";
import { bytes, compact, duration, relTime, utcFull } from "../../lib/format";
import { sourceLabel } from "../../lib/hazards";
import { useSource, useSources } from "../../lib/queries";
import { useUi } from "../../lib/store";
import { cx, Dot, EmptyState, ErrorState, Label, Skeleton, Sparkline } from "../../ui/primitives";
import s from "./SourcesView.module.css";

export const STATUS_META: Record<string, { color: string; label: string }> = {
  healthy: { color: "var(--ok)", label: "Healthy" },
  degraded: { color: "var(--warn)", label: "Degraded" },
  error: { color: "var(--bad)", label: "Error" },
  disabled: { color: "var(--text-4)", label: "Disabled" },
  idle: { color: "var(--text-3)", label: "Not yet synced" },
  reference: { color: "var(--accent)", label: "Reference / on demand" },
};

interface Meta {
  name: string;
  provider: string;
  category: string;
  homepage: string;
  docs_url: string;
  license: { name: string; url: string; commercial_use: boolean; notes?: string | null };
  attribution: string;
  update_interval: string;
  expected_latency: string;
  coverage: Record<string, string>;
  resolution: string;
  historical_depth: string;
  rate_limits: string;
  auth: { required: boolean; optional_env?: string | null; how_to_get?: string | null };
  cache_strategy: string;
  reliability: { rating: string; rationale: string };
  parser_version: string;
  limitations: string[];
  hazards: string[];
}

export function SourcesView() {
  const q = useSources();
  const [selected, setSelected] = useState<string | null>(null);
  const setView = useUi((st) => st.setView);
  const sources = q.data ?? [];
  const live = sources.filter((x) => x.status !== "reference" && x.status !== "disabled");
  const healthy = live.filter((x) => x.status === "healthy").length;

  return (
    <motion.div className={s.page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className={s.inner}>
        <header className={s.head}>
          <div>
            <div className="label">Data source registry</div>
            <h1 className={s.title}>Where every number comes from</h1>
            <p className={s.lede}>
              Each source is documented with its licence, attribution, cadence, latency, coverage, limits and known weaknesses, and monitored live. Keyed sources stay
              visibly disabled until you add a free key — ATLAS never requires one.
            </p>
          </div>
          <div className={s.summary}>
            <div className={s.summaryNum}>
              <span className="num">{healthy}</span>
              <span className={s.summaryOf}>/ {live.length}</span>
            </div>
            <div className={s.summaryLabel}>live sources healthy</div>
            <button type="button" className={s.back} onClick={() => setView("planet")}>
              Back to planet
            </button>
          </div>
        </header>

        {q.error && !q.data ? (
          <ErrorState title="Registry unavailable" message="The ATLAS engine is not reachable." onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className={s.grid}>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} height={156} radius={14} />
            ))}
          </div>
        ) : (
          <div className={s.grid}>
            {sources.map((src) => (
              <SourceCard key={src.id} src={src} onOpen={() => setSelected(src.id)} />
            ))}
          </div>
        )}
      </div>
      <AnimatePresence>{selected ? <SourceDetail id={selected} onClose={() => setSelected(null)} /> : null}</AnimatePresence>
    </motion.div>
  );
}

function SourceCard({ src, onOpen }: { src: SourceStatus; onOpen: () => void }) {
  const meta = src.meta as unknown as Meta;
  const st = STATUS_META[src.status] ?? STATUS_META.idle!;
  return (
    <button type="button" className={s.card} onClick={onOpen}>
      <div className={s.cardTop}>
        <span className={s.cardCat}>{meta.category.replace("-", " ")}</span>
        <span className={s.cardStatus}>
          <Dot color={st.color} pulse={src.status === "healthy"} size={6} />
          {st.label}
        </span>
      </div>
      <div className={s.cardName}>{meta.name}</div>
      <div className={s.cardProvider}>{meta.provider}</div>
      <div className={s.cardStats}>
        <Stat label="Last sync" value={src.last_success ? relTime(src.last_success) : "—"} />
        <Stat label="Data age" value={src.data_age_s != null ? duration(src.data_age_s) : "—"} />
        <Stat label="Records" value={src.stored_records ? compact(src.stored_records) : "—"} />
        <Stat label="Latency p50" value={src.latency_ms_p50 != null ? `${Math.round(src.latency_ms_p50)} ms` : "—"} />
      </div>
      <div className={s.cardFoot}>
        <span className={s.license}>{meta.license.name}</span>
        <span className={s.rating} title={meta.reliability.rationale}>
          {meta.reliability.rating}
        </span>
      </div>
      {src.disabled_reason ? (
        <div className={s.disabled}>
          <KeyRound size={12} /> {src.disabled_reason}
        </div>
      ) : null}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
    </div>
  );
}

function SourceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useSource(id);
  const client = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.syncSource(id),
    onSuccess: () => setTimeout(() => void client.invalidateQueries({ queryKey: ["source", id] }), 4000),
  });
  const src = q.data;
  const meta = src?.meta as unknown as Meta | undefined;
  const runs = src?.recent_runs ?? [];
  const latency = [...runs].reverse().map((r) => r.latency_ms ?? 0);
  const records = [...runs].reverse().map((r) => r.records_received);

  return (
    <motion.div className={s.drawerScrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.aside
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={`${sourceLabel(id)} details`}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 360, damping: 36 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.drawerHead}>
          <div>
            <div className="label">{meta?.category ?? "source"}</div>
            <h2 className={s.drawerTitle}>{meta?.name ?? id}</h2>
            <div className={s.cardProvider}>{meta?.provider}</div>
          </div>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        {!src || !meta ? (
          <div style={{ padding: 20, display: "grid", gap: 10 }}>
            <Skeleton height={60} />
            <Skeleton height={120} />
          </div>
        ) : (
          <div className={s.drawerBody}>
            <div className={s.drawerActions}>
              <a className={s.linkBtn} href={meta.homepage} target="_blank" rel="noreferrer noopener">
                Homepage <ExternalLink size={12} />
              </a>
              <a className={s.linkBtn} href={meta.docs_url} target="_blank" rel="noreferrer noopener">
                Documentation <ExternalLink size={12} />
              </a>
              {src.enabled && (src.jobs?.length ?? 0) > 0 ? (
                <button type="button" className={s.linkBtn} onClick={() => sync.mutate()} disabled={sync.isPending}>
                  <RefreshCw size={12} className={cx(sync.isPending && s.spin)} /> Sync now
                </button>
              ) : null}
            </div>
            {sync.data?.note ? <div className={s.hint}>{sync.data.note}</div> : null}

            <section>
              <Label>Licence & attribution</Label>
              <dl className={s.kv}>
                <dt>Licence</dt>
                <dd>
                  <a href={meta.license.url} target="_blank" rel="noreferrer noopener">
                    {meta.license.name}
                  </a>
                  {meta.license.commercial_use ? null : <span className={s.warnTag}>non-commercial</span>}
                </dd>
                {meta.license.notes ? (
                  <>
                    <dt>Notes</dt>
                    <dd>{meta.license.notes}</dd>
                  </>
                ) : null}
                <dt>Attribution</dt>
                <dd className={s.italic}>{meta.attribution}</dd>
              </dl>
            </section>

            <section>
              <Label>Characteristics</Label>
              <dl className={s.kv}>
                <dt>Update interval</dt>
                <dd>{meta.update_interval}</dd>
                <dt>Expected latency</dt>
                <dd>{meta.expected_latency}</dd>
                <dt>Coverage</dt>
                <dd>{Object.values(meta.coverage).join(" · ")}</dd>
                <dt>Resolution</dt>
                <dd>{meta.resolution}</dd>
                <dt>Historical depth</dt>
                <dd>{meta.historical_depth}</dd>
                <dt>Rate limits</dt>
                <dd>{meta.rate_limits}</dd>
                <dt>Cache strategy</dt>
                <dd>{meta.cache_strategy}</dd>
                <dt>Reliability</dt>
                <dd>
                  <strong>{meta.reliability.rating}</strong> — {meta.reliability.rationale}
                </dd>
                <dt>Parser</dt>
                <dd className="num">{meta.parser_version}</dd>
                <dt>Authentication</dt>
                <dd>
                  {meta.auth.required ? "Free key required" : "None"}
                  {meta.auth.optional_env ? (
                    <>
                      {" "}
                      · <code className={s.code}>{meta.auth.optional_env}</code>
                    </>
                  ) : null}
                  {meta.auth.how_to_get ? (
                    <>
                      {" "}
                      ·{" "}
                      <a href={meta.auth.how_to_get} target="_blank" rel="noreferrer noopener">
                        get one
                      </a>
                    </>
                  ) : null}
                </dd>
              </dl>
            </section>

            {meta.limitations.length ? (
              <section>
                <Label>Known limitations</Label>
                <ul className={s.limits}>
                  {meta.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section>
              <Label right={src.runs_24h ? `${src.runs_24h} runs / 24 h · ${bytes(src.bytes_24h)}` : undefined}>Sync history</Label>
              {runs.length ? (
                <>
                  <div className={s.sparks}>
                    <div>
                      <div className={s.sparkLabel}>Latency (ms)</div>
                      <Sparkline values={latency} width={190} height={34} color="#9cc9ff" label="Request latency per sync" />
                    </div>
                    <div>
                      <div className={s.sparkLabel}>Records received</div>
                      <Sparkline values={records} width={190} height={34} color="#8fd8b8" label="Records received per sync" />
                    </div>
                  </div>
                  <table className={s.runs}>
                    <thead>
                      <tr>
                        <th>Started</th>
                        <th>Status</th>
                        <th className={s.right}>Recv</th>
                        <th className={s.right}>Rej</th>
                        <th className={s.right}>Δ</th>
                        <th className={s.right}>ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.slice(0, 18).map((r) => (
                        <tr key={r.id} title={r.message ?? undefined}>
                          <td className="num">{utcFull(r.started_at).slice(5, 19)}</td>
                          <td>
                            <Dot color={STATUS_META[r.status === "ok" ? "healthy" : r.status]?.color ?? "var(--text-3)"} size={5} /> {r.status}
                            {r.from_cache ? <span className={s.cacheTag}>{r.stale ? "stale" : "cache"}</span> : null}
                          </td>
                          <td className={cx(s.right, "num")}>{r.records_received}</td>
                          <td className={cx(s.right, "num")}>{r.records_rejected}</td>
                          <td className={cx(s.right, "num")}>{r.records_changed}</td>
                          <td className={cx(s.right, "num")}>{r.latency_ms != null ? Math.round(r.latency_ms) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <EmptyState title="No syncs yet">{src.disabled_reason ?? "This source is used on demand or as a reference dataset."}</EmptyState>
              )}
            </section>
          </div>
        )}
      </motion.aside>
    </motion.div>
  );
}
