/**
 * Story mode: a narrated tour — the planet's state, then the most significant incidents (one
 * per hazard first), each framed by the camera with a caption built only from ATLAS data.
 */
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import type { IncidentSummary } from "../../lib/api";
import { focusIncident } from "../../lib/focus";
import { PROVENANCE_META } from "../../lib/hazards";
import { useOverview } from "../../lib/queries";
import { buildStory } from "../../lib/story";
import { useUi } from "../../lib/store";
import { HazardGlyph } from "../../ui/primitives";
import s from "./StoryPlayer.module.css";

const DWELL_MS = 11_000;

export function StoryPlayer({ incidents }: { incidents: IncidentSummary[] }) {
  const story = useUi((st) => st.story);
  if (!story) return null;
  return <Player incidents={incidents} />;
}

function Player({ incidents }: { incidents: IncidentSummary[] }) {
  const story = useUi((st) => st.story)!;
  const setStory = useUi((st) => st.setStory);
  const reduced = useUi((st) => st.reducedMotion);
  const overview = useOverview();
  // Freeze the line-up when the story starts so live updates don't reshuffle it mid-tour.
  const [lineup] = useState(incidents);
  const steps = useMemo(() => buildStory(overview.data, lineup), [overview.data, lineup]);
  const index = Math.min(story.index, steps.length - 1);
  const step = steps[index];
  const [elapsed, setElapsed] = useState(0);

  const go = (i: number) => setStory({ index: Math.max(0, Math.min(steps.length - 1, i)), playing: story.playing });

  // Camera and selection follow the step.
  useEffect(() => {
    if (!step) return;
    setElapsed(0);
    const ui = useUi.getState();
    if (step.kind === "incident" && step.incident) {
      focusIncident(step.incident);
    } else {
      ui.select(null);
      globeRef.current?.home();
    }
  }, [step]);

  // Auto-advance.
  useEffect(() => {
    if (!story.playing || !step) return;
    const started = performance.now() - elapsed;
    let raf = 0;
    const tick = () => {
      const e = performance.now() - started;
      setElapsed(e);
      if (e >= DWELL_MS) {
        if (index < steps.length - 1) setStory({ index: index + 1, playing: true });
        else setStory({ index, playing: false });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.playing, index, steps.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setStory({ index, playing: !story.playing });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!step) return null;
  const progress = Math.min(1, elapsed / DWELL_MS);

  return (
    <motion.section
      className={s.card}
      aria-label="Story mode"
      aria-live="polite"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
    >
      <div className={s.segments} aria-hidden>
        {steps.map((st, i) => (
          <button key={`${st.kind}-${i}`} type="button" className={s.segment} onClick={() => go(i)} tabIndex={-1}>
            <span className={s.fill} style={{ transform: `scaleX(${i < index ? 1 : i === index ? progress : 0})` }} />
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          className={s.content}
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -6 }}
          transition={{ duration: 0.35 }}
        >
          <div className={s.kicker}>
            {step.incident ? <HazardGlyph hazard={step.incident.hazard} size={13} /> : null}
            {step.kicker}
            <span className={s.count}>
              {index + 1} / {steps.length}
            </span>
          </div>
          <h2 className={s.title}>{step.title}</h2>
          <p className={s.body}>{step.body}</p>
          {step.chips.length ? (
            <div className={s.chips}>
              {step.chips.map((c) => (
                <span key={c.label} className={s.chip} title={provenance(c.provenance).label}>
                  <span className={s.chipLabel}>{c.label}</span>
                  <span className={s.chipValue}>{c.value}</span>
                  <span className={s.prov} style={{ color: provenance(c.provenance).color }}>
                    {provenance(c.provenance).short}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>

      <div className={s.controls}>
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous">
          <ChevronLeft size={16} />
        </button>
        <button type="button" className={s.play} onClick={() => setStory({ index, playing: !story.playing })} aria-label={story.playing ? "Pause" : "Play"}>
          {story.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button type="button" onClick={() => go(index + 1)} disabled={index === steps.length - 1} aria-label="Next">
          <ChevronRight size={16} />
        </button>
        <span className={s.spacer} />
        <button type="button" onClick={() => setStory(null)} aria-label="End story">
          <X size={15} />
        </button>
      </div>
    </motion.section>
  );
}

function provenance(kind: string): { label: string; short: string; color: string } {
  return PROVENANCE_META[kind as keyof typeof PROVENANCE_META] ?? { label: kind, short: kind.toUpperCase(), color: "var(--text-3)" };
}
