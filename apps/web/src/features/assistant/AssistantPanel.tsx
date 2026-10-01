/**
 * ATLAS Analyst (Phase 4): a local model on this computer answering from ATLAS's own data
 * through typed, read-only tools. Shows every tool it used, cites incidents, and says plainly
 * when the model or Ollama is unavailable.
 */
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, BookOpen, Check, Cpu, Database, RotateCcw, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { aiStatus, askStream, type AiEvent, type AiStatus, type AiTurn } from "../../lib/ai";
import { STATIC_MODE } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { hazardMeta, sourceLabel } from "../../lib/hazards";
import { Markdown } from "../../lib/markdown";
import { useUi } from "../../lib/store";
import { cx, HazardGlyph } from "../../ui/primitives";
import s from "./AssistantPanel.module.css";

const TOOL_LABEL: Record<string, string> = {
  search_incidents: "Searched incidents",
  get_incident: "Read incident",
  population_exposure: "Population exposure",
  planet_overview: "Planet overview",
  recent_changes: "Recent changes",
  earthquake_archive: "USGS archive",
  search_docs: "ATLAS methodology",
  source_status: "Source health",
};

const SUGGESTIONS = [
  "What are the most severe incidents right now?",
  "Any earthquakes of magnitude 6 or more this week?",
  "Which volcanoes have an elevated alert level?",
  "How does ATLAS decide the severity of a cyclone?",
  "What were the largest earthquakes in Japan from 2010 to 2015?",
];

interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  summary?: string;
  ok?: boolean;
}

interface Exchange {
  id: number;
  question: string;
  steps: ToolStep[];
  answer: string;
  citations?: Extract<AiEvent, { event: "citations" }>["data"];
  done?: Extract<AiEvent, { event: "done" }>["data"];
  error?: string;
  pending: boolean;
}

let seq = 0;

export function AssistantPanel() {
  const open = useUi((st) => st.assistantOpen);
  const close = useUi((st) => st.closeAssistant);
  return <AnimatePresence>{open ? <Panel key="assistant" onClose={close} /> : null}</AnimatePresence>;
}

function Panel({ onClose }: { onClose: () => void }) {
  const seed = useUi((st) => st.assistantSeed);
  const status = useQuery({ queryKey: ["ai-status"], queryFn: ({ signal }) => aiStatus(signal), enabled: !STATIC_MODE, staleTime: 30_000, retry: 0 });
  const [items, setItems] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState(seed);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = items.some((x) => x.pending);
  const ready = Boolean(status.data?.available);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => () => abort.current?.abort(), []);

  const update = (id: number, fn: (x: Exchange) => Exchange) => setItems((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy || !ready) return;
    const id = ++seq;
    const history: AiTurn[] = items.flatMap((x) =>
      x.answer
        ? [
            { role: "user" as const, content: x.question },
            { role: "assistant" as const, content: x.answer },
          ]
        : [],
    );
    setItems((xs) => [...xs, { id, question: q, steps: [], answer: "", pending: true }]);
    setDraft("");
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await askStream(
        q,
        history,
        (e) => {
          if (e.event === "tool_call") update(id, (x) => ({ ...x, steps: [...x.steps, { name: e.data.name, args: e.data.args }] }));
          else if (e.event === "tool_result")
            update(id, (x) => {
              const steps = [...x.steps];
              const i = steps.map((st) => st.name).lastIndexOf(e.data.name);
              if (i >= 0) steps[i] = { ...steps[i]!, summary: e.data.summary, ok: e.data.ok };
              return { ...x, steps };
            });
          else if (e.event === "token") update(id, (x) => ({ ...x, answer: x.answer + e.data.text }));
          else if (e.event === "reset") update(id, (x) => ({ ...x, answer: "" }));
          else if (e.event === "citations") update(id, (x) => ({ ...x, citations: e.data }));
          else if (e.event === "done") update(id, (x) => ({ ...x, done: e.data, pending: false }));
          else if (e.event === "error") update(id, (x) => ({ ...x, error: e.data.message, pending: false }));
        },
        { signal: ctrl.signal },
      );
      update(id, (x) => ({ ...x, pending: false }));
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      update(id, (x) => ({ ...x, pending: false, error: aborted ? "Stopped." : (err as Error).message }));
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(draft);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <motion.aside
      className={s.panel}
      aria-label="ATLAS Analyst"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
    >
      <header className={s.head}>
        <span className={s.mark}>
          <Sparkles size={14} />
        </span>
        <div className={s.headText}>
          <div className={s.title}>ATLAS Analyst</div>
          <div className={s.sub}>
            {STATIC_MODE ? "Local AI · not on the public snapshot" : ready ? `Local model · ${status.data?.model}` : status.isLoading ? "Checking local model…" : "Local model unavailable"}
          </div>
        </div>
        {items.length ? (
          <button type="button" className={s.icon} onClick={() => setItems([])} aria-label="New conversation" title="New conversation" disabled={busy}>
            <RotateCcw size={14} />
          </button>
        ) : null}
        <button type="button" className={s.icon} onClick={onClose} aria-label="Close assistant">
          <X size={15} />
        </button>
      </header>

      <div className={s.body} ref={scroller}>
        {STATIC_MODE || (status.data && !status.data.available) || status.error ? (
          <Setup status={status.data} offline={Boolean(status.error)} onRetry={() => void status.refetch()} />
        ) : items.length === 0 ? (
          <div className={s.empty}>
            <p className={s.lede}>Ask about live incidents, history or how ATLAS works. Answers come only from ATLAS&apos;s data, with every source cited.</p>
            <div className={s.suggestions}>
              {SUGGESTIONS.map((q) => (
                <button key={q} type="button" className={s.suggestion} onClick={() => void ask(q)} disabled={!ready}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          items.map((x) => <ExchangeView key={x.id} x={x} />)
        )}
      </div>

      {!STATIC_MODE ? (
        <form className={s.composer} onSubmit={onSubmit}>
          <textarea
            ref={input}
            className={s.input}
            rows={2}
            placeholder={ready ? "Ask about incidents, places, history…" : "The local model is not available"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            maxLength={1000}
            disabled={!ready}
            aria-label="Question for the assistant"
          />
          {busy ? (
            <button type="button" className={s.send} onClick={() => abort.current?.abort()} aria-label="Stop">
              <Square size={13} />
            </button>
          ) : (
            <button type="submit" className={s.send} disabled={!ready || !draft.trim()} aria-label="Ask">
              <ArrowUp size={15} />
            </button>
          )}
        </form>
      ) : null}
      <p className={s.fine}>Runs entirely on this computer (Ollama). AI answers can be wrong: check the cited incidents. Not an official warning service.</p>
    </motion.aside>
  );
}

function ExchangeView({ x }: { x: Exchange }) {
  return (
    <div className={s.exchange}>
      <div className={s.question}>{x.question}</div>
      {x.steps.length ? (
        <ol className={s.steps} aria-label="Tools used">
          {x.steps.map((st, i) => (
            <li key={`${st.name}-${i}`} className={cx(s.step, st.ok === false && s.stepBad)}>
              <span className={s.stepIcon}>{st.ok === undefined ? <span className={s.spinner} /> : st.ok ? <Check size={11} /> : <TriangleAlert size={11} />}</span>
              <span className={s.stepName}>{TOOL_LABEL[st.name] ?? st.name}</span>
              <span className={s.stepArgs}>{formatArgs(st.args)}</span>
              {st.summary ? <span className={s.stepSummary}>{st.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div className={s.answer}>
        {x.answer ? <Markdown text={x.answer} renderRef={(id, key) => <RefChip key={key} id={id} known={x.citations?.incidents} />} /> : null}
        {x.pending ? <span className={s.caret} aria-hidden /> : null}
        {!x.answer && x.pending && !x.steps.length ? <span className={s.thinking}>Thinking…</span> : null}
      </div>
      {x.error ? (
        <div className={s.error}>
          <TriangleAlert size={13} /> {x.error}
        </div>
      ) : null}
      {x.citations && (x.citations.sources.length || x.citations.docs.length || x.citations.unverified_ids.length) ? (
        <div className={s.cites}>
          {x.citations.sources.map((src) => (
            <span key={src} className={s.cite}>
              <Database size={10} /> {sourceLabel(src)}
            </span>
          ))}
          {x.citations.docs.map((d) => (
            <span key={`${d.doc}-${d.section}`} className={s.cite} title={d.doc}>
              <BookOpen size={10} /> {d.section}
            </span>
          ))}
          {x.citations.unverified_ids.length ? (
            <span className={cx(s.cite, s.citeWarn)} title="Mentioned in the answer but not returned by any tool">
              <TriangleAlert size={10} /> {x.citations.unverified_ids.length} unverified id{x.citations.unverified_ids.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      ) : null}
      {x.done ? (
        <div className={s.meta}>
          <Cpu size={10} /> {x.done.model} · {x.done.tool_calls} tool call{x.done.tool_calls === 1 ? "" : "s"} · {x.done.elapsed_s}s
        </div>
      ) : null}
    </div>
  );
}

function RefChip({ id, known }: { id: string; known?: { id: string; title: string; hazard: string | null; lat: number | null; lon: number | null }[] }) {
  const inc = known?.find((k) => k.id === id);
  if (!inc) {
    return (
      <span className={cx(s.ref, s.refUnknown)} title="Not returned by any tool in this answer">
        {id}
      </span>
    );
  }
  const hz = inc.hazard ? hazardMeta(inc.hazard) : null;
  return (
    <button
      type="button"
      className={s.ref}
      style={hz ? ({ "--hz": hz.color } as React.CSSProperties) : undefined}
      onClick={() => focusIncident({ id: inc.id, hazard: inc.hazard ?? "earthquake", lat: inc.lat, lon: inc.lon, bbox: null })}
      title={`${inc.title} — open on the globe`}
    >
      {inc.hazard ? <HazardGlyph hazard={inc.hazard} size={11} /> : null}
      {inc.title.length > 46 ? `${inc.title.slice(0, 45)}…` : inc.title}
    </button>
  );
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

function Setup({ status, offline, onRetry }: { status?: AiStatus; offline: boolean; onRetry: () => void }) {
  const model = status?.recommended_model ?? "qwen2.5:7b";
  return (
    <div className={s.setup}>
      <p className={s.lede}>
        {STATIC_MODE
          ? "The ATLAS Analyst runs a language model on your own computer, so questions and answers never leave it. It isn't available on this public snapshot."
          : offline
            ? "The ATLAS engine is not reachable."
            : (status?.reason ?? "The local model is unavailable.")}
      </p>
      <ol className={s.setupSteps}>
        <li>
          Install <strong>Ollama</strong> (free, runs models locally): ollama.com/download
        </li>
        <li>
          Pull a model that supports tool calling, e.g. <code>ollama pull {model}</code> (≈ 4.7 GB; 8 GB of GPU or system memory recommended)
        </li>
        <li>
          {STATIC_MODE ? (
            <>
              Use the ATLAS desktop app, or run ATLAS locally (<code>pnpm setup</code>, then <code>pnpm dev</code>), and open the assistant.
            </>
          ) : (
            "Keep Ollama running, then check again."
          )}
        </li>
      </ol>
      {!STATIC_MODE ? (
        <button type="button" className={s.retry} onClick={onRetry}>
          Check again
        </button>
      ) : null}
    </div>
  );
}
