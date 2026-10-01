import { ChevronDown, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { IncidentDetail, ObservationOut } from "../../lib/api";
import { observedAgo, relTime, utcFull } from "../../lib/format";
import { cx, Label } from "../../ui/primitives";
import s from "./IncidentPanel.module.css";

export function SourceDrawer({ d }: { d: IncidentDetail }) {
  return (
    <div className={s.stack}>
      <section>
        <Label right="licence · freshness">Data sources</Label>
        <ul className={s.citations}>
          {d.citations.map((c) => {
            const obs = d.observations.filter((o) => o.source === c.source_id);
            return <CitationItem key={c.source_id} c={c} obs={obs} />;
          })}
        </ul>
      </section>
    </div>
  );
}

function CitationItem({ c, obs }: { c: IncidentDetail["citations"][number]; obs: ObservationOut[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={s.citation}>
      <button type="button" className={s.citationHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={s.citationName}>
          {c.name}
          <span className={s.rating} title="Reliability rating from the Data Source Registry">
            {c.reliability}
          </span>
        </span>
        <span className={s.citationWhat}>{c.contributed}</span>
        <span className={s.citationMeta}>
          {c.source_updated_at ? <>Source updated {observedAgo(c.source_updated_at)}</> : null}
          {c.retrieved_at ? <> · retrieved {relTime(c.retrieved_at)}</> : null}
        </span>
        <ChevronDown size={14} className={cx(s.citationChev, open && s.chevOpen)} aria-hidden />
      </button>
      {open ? (
        <div className={s.citationBody}>
          <div className={s.attrib}>{c.attribution}</div>
          <div className={s.licence}>
            Licence:{" "}
            <a href={c.license_url} target="_blank" rel="noreferrer noopener">
              {c.license}
            </a>
          </div>
          {obs.map((o) => (
            <RawRecord key={o.id} o={o} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function RawRecord({ o }: { o: ObservationOut }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className={s.record}>
      <div className={s.recordHead}>
        <span className="num">{o.external_id}</span>
        <span className={s.dim}>v{o.version}</span>
        {o.url ? (
          <a href={o.url} target="_blank" rel="noreferrer noopener" className={s.recordLink}>
            Open <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
      <dl className={s.kv}>
        <dt>Event time</dt>
        <dd>{utcFull(o.event_time)}</dd>
        <dt>Source updated</dt>
        <dd>{utcFull(o.source_updated_at)}</dd>
        <dt>First ingested</dt>
        <dd>{utcFull(o.first_seen_at)}</dd>
        <dt>Last seen in feed</dt>
        <dd>{utcFull(o.last_seen_at)}</dd>
        {o.status ? (
          <>
            <dt>Status</dt>
            <dd>{o.status}</dd>
          </>
        ) : null}
      </dl>
      {o.description ? <p className={s.recordDesc}>{o.description}</p> : null}
      <button type="button" className={s.rawBtn} onClick={() => setRaw((v) => !v)} aria-expanded={raw}>
        {raw ? "Hide" : "Show"} normalised record
      </button>
      {raw ? <pre className={s.raw}>{JSON.stringify(o, null, 2)}</pre> : null}
    </div>
  );
}
