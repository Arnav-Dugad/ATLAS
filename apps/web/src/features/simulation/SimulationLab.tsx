/**
 * Simulation Lab: a hypothetical earthquake's median shaking (Allen, Wald & Worden 2012) and the
 * residents inside each intensity band. Labelled SIMULATION — NOT A FORECAST everywhere it
 * appears; no damage or casualty figures.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Crosshair, FlaskConical, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { globeRef } from "../../globe/ref";
import { coord, compact, dist } from "../../lib/format";
import { engineScenario, localScenario, type Scenario } from "../../lib/simulation";
import { useUi } from "../../lib/store";
import { cx } from "../../ui/primitives";
import s from "./SimulationLab.module.css";
import { useUnits } from "../../lib/settings";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SimulationLab() {
  useUnits(); // re-render when display units change
  const sim = useUi((st) => st.simulation);
  const pick = useUi((st) => st.groundPick);
  if (!sim && pick === "simulation") return <PickHint />;
  if (!sim) return null;
  return <Lab />;
}

function PickHint() {
  const setPick = useUi((st) => st.setGroundPick);
  return (
    <motion.div className={s.hint} role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
      <FlaskConical size={14} /> Click anywhere on the globe to place a scenario earthquake
      <button type="button" onClick={() => setPick(null)}>
        Cancel
      </button>
    </motion.div>
  );
}

function Lab() {
  const sim = useUi((st) => st.simulation)!;
  const patch = useUi((st) => st.patchSimulation);
  const close = useUi((st) => st.setSimulation);
  const pick = useUi((st) => st.groundPick);
  const setPick = useUi((st) => st.setGroundPick);
  const input = useMemo(() => ({ lat: sim.lat, lon: sim.lon, magnitude: sim.magnitude, depth_km: sim.depth_km }), [sim.lat, sim.lon, sim.magnitude, sim.depth_km]);
  const local = useMemo(() => localScenario(input), [input]);
  const settled = useDebounced(input, 450);
  const remote = useQuery({
    queryKey: ["scenario", settled],
    queryFn: ({ signal }) => engineScenario(settled, signal),
    staleTime: Infinity,
    retry: 0,
  });
  // Bands follow the sliders instantly; residents arrive when the engine has counted them.
  const scenario: Scenario = remote.data && remote.data.input.magnitude === input.magnitude && remote.data.input.depth_km === input.depth_km && remote.data.input.lat === input.lat && remote.data.input.lon === input.lon ? remote.data : local;
  const hasResidents = scenario.bands.some((b) => b.residents_in_band != null);

  useEffect(() => {
    globeRef.current?.setSimulation({
      lat: sim.lat,
      lon: sim.lon,
      label: `Scenario M${sim.magnitude.toFixed(1)} · not a forecast`,
      bands: scenario.bands,
    });
  }, [scenario, sim.lat, sim.lon, sim.magnitude]);
  useEffect(() => () => globeRef.current?.setSimulation(null), []);

  const outer = scenario.bands[scenario.bands.length - 1];

  return (
    <motion.section
      className={s.card}
      aria-label="Simulation lab"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    >
      <div className={s.banner} role="note">
        <FlaskConical size={13} /> SIMULATION — NOT A FORECAST
      </div>
      <header className={s.head}>
        <div className={s.title}>Earthquake shaking scenario{sim.subject ? ` · ${sim.subject}` : ""}</div>
        <button type="button" className={s.close} onClick={() => close(null)} aria-label="Close simulation">
          <X size={14} />
        </button>
      </header>

      <div className={s.controls}>
        <label className={s.slider}>
          <span className={s.sliderHead}>
            Magnitude <strong>M{sim.magnitude.toFixed(1)}</strong>
          </span>
          <input type="range" min={4.5} max={8.5} step={0.1} value={sim.magnitude} onChange={(e) => patch({ magnitude: Number(e.target.value) })} />
        </label>
        <label className={s.slider}>
          <span className={s.sliderHead}>
            Depth <strong>{sim.depth_km.toFixed(0)} km</strong>
          </span>
          <input type="range" min={1} max={70} step={1} value={sim.depth_km} onChange={(e) => patch({ depth_km: Number(e.target.value) })} />
        </label>
        <div className={s.where}>
          <span className={s.coord}>{coord(sim.lat, sim.lon)}</span>
          <button type="button" className={cx(s.pick, pick === "simulation" && s.pickOn)} onClick={() => setPick(pick === "simulation" ? null : "simulation")} aria-pressed={pick === "simulation"}>
            <Crosshair size={13} /> {pick === "simulation" ? "Click the globe…" : "Move epicentre"}
          </button>
        </div>
      </div>

      <div className={s.summary}>
        Median intensity at the epicentre <strong>{scenario.epicentre_mmi.toFixed(1)}</strong>
        {outer ? (
          <>
            {" "}
            · light shaking (IV) out to about <strong>{dist(outer.radius_km)}</strong>
          </>
        ) : null}
      </div>

      <table className={s.table}>
        <thead>
          <tr>
            <th>Intensity</th>
            <th>Shaking</th>
            <th>Potential damage*</th>
            <th className={s.num}>Radius</th>
            <th className={s.num}>Residents</th>
          </tr>
        </thead>
        <tbody>
          {scenario.bands.map((b) => (
            <tr key={b.level}>
              <td>
                <span className={s.chip} style={{ background: b.color }}>
                  {b.roman}
                </span>
              </td>
              <td>{b.shaking}</td>
              <td className={s.dim}>{b.damage}</td>
              <td className={s.num}>{b.radius_km < 1 ? `<${dist(1)}` : dist(b.radius_km)}</td>
              <td className={s.num}>{b.residents_in_band != null ? compact(b.residents_in_band) : remote.isFetching ? "…" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={s.foot}>
        * USGS ShakeMap legend wording for each intensity, not an estimate for this scenario. Residents:{" "}
        {hasResidents ? (scenario.population_dataset ?? "GHSL model") : (scenario.population_note ?? "unavailable")}
      </p>
      {scenario.notes.length ? (
        <ul className={s.notes}>
          {scenario.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <details className={s.method}>
        <summary>Model, uncertainty and limits</summary>
        <p>
          {scenario.model.name}. {scenario.model.citation}. Uncertainty: {scenario.model.uncertainty}.
        </p>
        <ul>
          {scenario.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </details>
    </motion.section>
  );
}
