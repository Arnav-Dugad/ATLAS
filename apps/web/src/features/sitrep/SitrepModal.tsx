/** One-click situation report for the planet or the current view; every sentence cited. */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Check, ClipboardCopy, Download, FileText, Printer, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { globeRef } from "../../globe/ref";
import { api, type IncidentSummary } from "../../lib/api";
import { utcFull } from "../../lib/format";
import { summarise } from "../../lib/lastVisit";
import { buildSitrep, sitrepMarkdown, type Sitrep } from "../../lib/sitrep";
import { useSitrep } from "../../lib/sitrepStore";
import { useUi } from "../../lib/store";
import { Segmented } from "../../ui/primitives";
import s from "./SitrepModal.module.css";

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function printable(r: Sitrep, windowLabel: string): string {
  const body = r.paragraphs
    .map((p) => `<h2>${escapeHtml(p.heading)}</h2><ul>${p.sentences.map((x) => `<li>${escapeHtml(x.text)} <sup>${x.cites.map((n) => `[${n}]`).join("")}</sup></li>`).join("")}</ul>`)
    .join("");
  const refs = r.references.map((x) => `<li>${escapeHtml(x.label)}${x.detail ? ` — ${escapeHtml(x.detail)}` : ""}${x.url ? ` &lt;${escapeHtml(x.url)}&gt;` : ""}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(r.title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:20px}sup{color:#555}footer{margin-top:24px;color:#555;font-size:12px}</style><h1>ATLAS ${escapeHtml(r.title)}</h1><p>Generated ${escapeHtml(utcFull(r.generatedAt))} · time window ${escapeHtml(windowLabel)}</p>${body}<h2>References</h2><ol>${refs}</ol><footer>Built by ATLAS from its own records with fixed templates. Severity is an ordinal ATLAS scale, not an impact estimate. Not an official alert: follow your national authorities.</footer>`;
}

export function SitrepModal({ incidents }: { incidents: IncidentSummary[] }) {
  const close = () => useSitrep.getState().setOpen(false);
  const windowLabel = useUi((st) => st.window);
  const [scope, setScope] = useState<"planet" | "view">(() => (globeRef.current?.viewBbox() ? "view" : "planet"));
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sources = useQuery({ queryKey: ["sources"], queryFn: ({ signal }) => api.sources(signal), staleTime: 5 * 60_000 });
  const since = useMemo(() => new Date(Date.now() - 24 * 3600_000).toISOString(), []);
  const changes = useQuery({ queryKey: ["sitrep-changes", since], queryFn: ({ signal }) => api.changes({ since, min_significance: 1, limit: 500 }, signal), staleTime: 5 * 60_000 });
  const bbox = scope === "view" ? (globeRef.current?.viewBbox() ?? null) : null;

  const report = useMemo(() => {
    const sum = summarise(changes.data?.items ?? []);
    return buildSitrep({
      incidents,
      sources: sources.data ?? [],
      scope: bbox ? { label: "in the current view", name: "Current view", bbox } : { label: "worldwide", name: "Worldwide", bbox: null },
      windowLabel,
      changes24h: { created: sum.created.length, escalated: sum.escalated.length },
    });
    // bbox is read once per scope switch on purpose: the report is a snapshot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, sources.data, changes.data, scope, windowLabel]);
  const md = useMemo(() => sitrepMarkdown(report, windowLabel), [report, windowLabel]);

  useEffect(() => ref.current?.focus(), []);

  const download = () => {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atlas-sitrep-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const print = () => {
    const w = window.open("", "_blank", "noopener=no,width=820,height=900");
    if (!w) return;
    w.document.write(printable(report, windowLabel));
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <motion.div className={s.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div
        ref={ref}
        tabIndex={-1}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sitrep-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
      >
        <header className={s.head}>
          <h2 id="sitrep-title">
            <FileText size={16} aria-hidden /> Situation report
          </h2>
          <Segmented<"planet" | "view">
            size="sm"
            label="Report scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "planet", label: "Whole planet" },
              { value: "view", label: "Current view" },
            ]}
          />
          <button type="button" className={s.close} onClick={close} aria-label="Close (Esc)">
            <X size={15} />
          </button>
        </header>
        <div className={s.body}>
          <h1 className={s.title}>{report.title}</h1>
          <p className={s.meta}>
            Generated {utcFull(report.generatedAt)} · time window {windowLabel} · every sentence cites its sources
          </p>
          {report.paragraphs.map((p) => (
            <section key={p.heading}>
              <h3>{p.heading}</h3>
              <ul>
                {p.sentences.map((x) => (
                  <li key={x.text}>
                    {x.text}{" "}
                    <span className={s.cites}>
                      {x.cites.map((n) => (
                        <a key={n} href={`#ref-${n}`}>
                          [{n}]
                        </a>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <section>
            <h3>References</h3>
            <ol className={s.refs}>
              {report.references.map((r) => (
                <li key={r.n} id={`ref-${r.n}`}>
                  <strong>{r.label}</strong>
                  {r.detail ? ` — ${r.detail}` : ""}
                  {r.url ? (
                    <>
                      {" "}
                      <a href={r.url} target="_blank" rel="noreferrer noopener">
                        {r.url}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
          <p className={s.disclaimer}>
            Built from ATLAS records with fixed templates; no sentence is generated freely. Severity is an ordinal ATLAS scale, not an impact estimate. Not an
            official alert: follow your national authorities.
          </p>
        </div>
        <footer className={s.foot}>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(md).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
            }
          >
            {copied ? <Check size={14} /> : <ClipboardCopy size={14} />} Copy Markdown
          </button>
          <button type="button" onClick={download}>
            <Download size={14} /> Download .md
          </button>
          <button type="button" onClick={print}>
            <Printer size={14} /> Print / PDF
          </button>
          <span className={s.spacer} />
          <button
            type="button"
            className={s.ai}
            onClick={() => {
              close();
              useUi.getState().openAssistant(
                `Summarise the current situation${bbox ? " in the area I am looking at" : " worldwide"} in five sentences: the most severe active incidents, what changed in the last 24 hours, and any compound events. Cite every fact.`,
              );
            }}
          >
            <Sparkles size={14} /> Ask the local analyst for a summary
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
