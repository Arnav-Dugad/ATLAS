/**
 * Settings — Windows desktop app only (WINDOWS_APP). Optional API keys (OpenAQ, ReliefWeb),
 * data packs (install, import an existing download, remove), panel style, graphics quality.
 * Keys are sent to the local engine, which encrypts them for this Windows user (DPAPI) and
 * never sends them back; this view only ever sees "set" and the last four characters.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderInput,
  HardDrive,
  Info,
  KeyRound,
  LoaderCircle,
  MonitorCog,
  Palette,
  Trash,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, ApiError, type AppSettings, type CredentialName, type CredentialTest, type PackStatus, type PackTask } from "../../lib/api";
import { NATIVE, pickFolder } from "../../lib/desktop";
import { relTime } from "../../lib/format";
import { gpuInfo } from "../../lib/media";
import {
  type Accent,
  ACCENTS,
  type Density,
  isIntegratedGpu,
  QUALITY,
  type QualityChoice,
  resolveQuality,
  type SettingsSection,
  type Surface,
  type LayoutPreset,
  PRESET_WIDTHS,
  type Units,
  useSettings,
} from "../../lib/settings";
import { useUi } from "../../lib/store";
import { cx, Segmented, Toggle } from "../../ui/primitives";
import { AppSection } from "./AppSection";
import s from "./SettingsModal.module.css";
import { showUndo } from "../../lib/undo";

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "sources", label: "Data sources", icon: <KeyRound size={15} /> },
  { id: "packs", label: "Data packs", icon: <Database size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "graphics", label: "Graphics", icon: <Cpu size={15} /> },
  { id: "app", label: "App", icon: <MonitorCog size={15} /> },
  { id: "about", label: "About & storage", icon: <Info size={15} /> },
];

const BUSY: PackTask["state"][] = ["starting", "downloading", "extracting", "copying", "indexing"];
const isBusy = (t: PackTask | null | undefined) => !!t && BUSY.includes(t.state);

export function SettingsModal() {
  const section = useSettings((st) => st.section);
  const close = useSettings((st) => st.closeSettings);
  const open = useSettings((st) => st.openSettings);
  const dialog = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.settings(signal),
    refetchInterval: (query) => (query.state.data?.packs.some((p) => isBusy(p.task)) ? 800 : false),
  });

  // When a pack finishes, everything that shows exposure must refetch.
  const busyBefore = useRef(false);
  const busyNow = q.data?.packs.some((p) => isBusy(p.task)) ?? false;
  useEffect(() => {
    if (busyBefore.current && !busyNow) void client.invalidateQueries({ predicate: (qq) => qq.queryKey[0] !== "settings" });
    busyBefore.current = busyNow;
  }, [busyNow, client]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      className={s.scrim}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        ref={dialog}
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={onKeyDown}
        initial={{ opacity: 0, y: 10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
      >
        <nav className={s.nav} aria-label="Settings sections">
          <h2 id="settings-title" className={s.title}>
            Settings
          </h2>
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              className={cx(s.navItem, section === sec.id && s.navOn)}
              aria-current={section === sec.id ? "page" : undefined}
              onClick={() => open(sec.id)}
              data-autofocus={section === sec.id ? "" : undefined}
            >
              {sec.icon}
              {sec.label}
            </button>
          ))}
          <div className={s.navFoot}>
            <kbd>Ctrl</kbd> <kbd>,</kbd> opens Settings
          </div>
        </nav>
        <div className={s.body}>
          <button type="button" className={s.close} onClick={close} aria-label="Close settings (Esc)" title="Close (Esc)">
            <X size={16} />
          </button>
          <div className={s.scroll}>
            {q.error && !q.data ? (
              <div className={s.callout} data-tone="bad">
                <CircleAlert size={15} /> {q.error instanceof ApiError ? q.error.message : "The engine is not reachable."}
              </div>
            ) : null}
            {section === "sources" ? <SourcesSection data={q.data} /> : null}
            {section === "packs" ? <PacksSection data={q.data} /> : null}
            {section === "appearance" ? <AppearanceSection /> : null}
            {section === "graphics" ? <GraphicsSection /> : null}
            {section === "app" ? <AppSection data={q.data} /> : null}
            {section === "about" ? <AboutSection data={q.data} /> : null}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ shared bits */
function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={s.header}>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </header>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "idle"; children: ReactNode }) {
  return (
    <span className={s.pill} data-tone={tone}>
      {children}
    </span>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={s.extLink}>
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children} <ExternalLink size={11} />
      </a>
      <button
        type="button"
        className={s.copyBtn}
        title="Copy link"
        aria-label={`Copy link ${href}`}
        onClick={() => {
          void navigator.clipboard?.writeText(href).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </span>
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Is the engine running?";
}

/* ------------------------------------------------------------------ data sources */
function SourcesSection({ data }: { data?: AppSettings }) {
  const rw = data?.connectors.reliefweb;
  const rwStatus: { tone: "ok" | "warn" | "bad" | "idle"; text: string } | undefined = !data?.credentials.reliefweb_appname.configured
    ? undefined
    : rw?.last_ok
      ? { tone: "ok", text: `Active · synced ${relTime(rw.last_ok)}` }
      : rw?.last_error?.includes("403")
        ? { tone: "warn", text: "Waiting for ReliefWeb's approval" }
        : rw?.last_error
          ? { tone: "bad", text: "Last sync failed" }
          : { tone: "idle", text: "Saved · first sync pending" };
  return (
    <>
      <Header title="Data sources">
        Two optional free services add more to ATLAS. Everything else works without them. Keys are encrypted for your Windows account on this PC and only
        ever sent to the service they belong to.
      </Header>

      <CredentialCard
        name="openaq_api_key"
        title="OpenAQ — air quality"
        what="Measured PM2.5, PM10, NO₂, O₃, SO₂ and CO from monitoring stations within 25 km of an incident."
        status={data?.credentials.openaq_api_key}
        secret
        placeholder="Paste your OpenAQ API key"
        steps={[
          <>
            Create a free account: <ExtLink href="https://explore.openaq.org/register">explore.openaq.org/register</ExtLink>
          </>,
          <>
            Confirm your email, sign in and open <ExtLink href="https://explore.openaq.org/account">explore.openaq.org/account</ExtLink> — your API key
            is shown there.
          </>,
          <>Copy the key, paste it below and press Save. ATLAS checks it with OpenAQ straight away.</>,
        ]}
      />

      <CredentialCard
        name="reliefweb_appname"
        title="ReliefWeb — humanitarian disaster reports"
        what="UN OCHA's ReliefWeb disaster records (with GLIDE numbers) corroborate incidents and link to situation reports."
        status={data?.credentials.reliefweb_appname}
        liveStatus={rwStatus}
        placeholder="e.g. yourname-atlas-disasters-x7k2"
        suggest
        steps={[
          <>
            Read the rules and open the request form: <ExtLink href="https://apidoc.reliefweb.int/parameters#appname">apidoc.reliefweb.int → appname</ExtLink>{" "}
            (since 1 November 2025 every app needs a pre-approved appname).
          </>,
          <>
            Choose an appname that combines your name or organisation, the purpose and some random characters — for example{" "}
            <code>yourname-atlas-disasters-x7k2</code>. Letters, digits, dots, dashes and underscores only.
          </>,
          <>Submit the form. ReliefWeb reviews it and replies by email (they don't promise a time).</>,
          <>
            Enter the same appname below and press Save. You can save it before approval: ATLAS keeps retrying (at most hourly) and starts using ReliefWeb
            as soon as it is approved.
          </>,
        ]}
      />
    </>
  );
}

function CredentialCard(props: {
  name: CredentialName;
  title: string;
  what: string;
  status?: AppSettings["credentials"][CredentialName];
  liveStatus?: { tone: "ok" | "warn" | "bad" | "idle"; text: string };
  steps: ReactNode[];
  placeholder: string;
  secret?: boolean;
  suggest?: boolean;
}) {
  const { name, status } = props;
  const client = useQueryClient();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [result, setResult] = useState<CredentialTest | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ["settings"] });

  const save = useMutation({
    mutationFn: (v: string | null) => api.saveCredential(name, v),
    onSuccess: (res, v) => {
      setResult(v ? res.test : null);
      setValue("");
      refresh();
      void client.invalidateQueries({ predicate: (qq) => ["air-quality", "sources", "source"].includes(String(qq.queryKey[0])) });
    },
    onError: (err) => setResult({ ok: false, message: errorText(err) }),
  });
  const test = useMutation({
    mutationFn: () => api.testCredential(name),
    onSuccess: (res) => {
      setResult(res);
      refresh();
    },
    onError: (err) => setResult({ ok: false, message: errorText(err) }),
  });

  const pill = !status?.configured
    ? { tone: "idle" as const, text: "Not set" }
    : result
      ? result.ok
        ? { tone: "ok" as const, text: "Working" }
        : result.pending
          ? { tone: "warn" as const, text: "Waiting for approval" }
          : { tone: "bad" as const, text: "Check failed" }
      : (props.liveStatus ?? { tone: "ok" as const, text: "Saved" });
  const busy = save.isPending || test.isPending;

  return (
    <section className={s.card} aria-labelledby={`cred-${name}`}>
      <div className={s.cardHead}>
        <div>
          <h4 id={`cred-${name}`}>{props.title}</h4>
          <p className={s.muted}>{props.what}</p>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>

      <ol className={s.steps}>
        {props.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      {status?.configured ? (
        <div className={s.saved}>
          <Check size={13} /> Saved{status.hint ? <code>{status.hint}</code> : null}
          {status.source === "environment" ? <span className={s.muted}>(from an environment variable — that one takes priority)</span> : null}
        </div>
      ) : null}

      <form
        className={s.inputRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save.mutate(value.trim());
        }}
      >
        <div className={s.inputWrap}>
          <input
            className={s.input}
            type={props.secret && !show ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={status?.configured ? "Enter a new value to replace it" : props.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={name === "openaq_api_key" ? "OpenAQ API key" : "ReliefWeb appname"}
          />
          {props.secret ? (
            <button type="button" className={s.eye} onClick={() => setShow((v) => !v)} aria-label={show ? "Hide key" : "Show key"}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          ) : null}
        </div>
        {props.suggest && !value ? (
          <button
            type="button"
            className={s.btn}
            onClick={() => setValue(`atlas-disasters-${Math.random().toString(36).slice(2, 7)}`)}
            title="Fill in a starting point; put your name or organisation in front"
          >
            Suggest
          </button>
        ) : null}
        <button type="submit" className={cx(s.btn, s.primary)} disabled={!value.trim() || busy}>
          {save.isPending ? <LoaderCircle size={14} className={s.spin} /> : null}
          Save
        </button>
      </form>

      <div className={s.actions}>
        {status?.configured ? (
          <>
            <button type="button" className={s.btnGhost} onClick={() => test.mutate()} disabled={busy}>
              {test.isPending ? <LoaderCircle size={13} className={s.spin} /> : null} Test again
            </button>
            <button type="button" className={s.btnGhost} data-tone="bad" onClick={() => showUndo(`${props.title.split(" — ")[0]} key will be removed`, { undo: () => undefined, commit: () => save.mutate(null) })} disabled={busy}>
              <Trash size={13} /> Remove
            </button>
          </>
        ) : null}
      </div>

      {result ? (
        <div className={s.callout} data-tone={result.ok ? "ok" : result.pending ? "warn" : "bad"} role="status">
          {result.ok ? <Check size={15} /> : <CircleAlert size={15} />}
          <span>{result.message}</span>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ data packs */
function mb(bytes: number | null | undefined): string {
  return bytes == null ? "?" : (bytes / 1048576).toFixed(bytes > 100 * 1048576 ? 0 : 1);
}

function PacksSection({ data }: { data?: AppSettings }) {
  return (
    <>
      <Header title="Data packs">
        Large optional datasets, stored only on this PC. The Population Pack powers "people living nearby" in Exposure and residents per band in
        earthquake scenarios.
      </Header>
      {data?.packs.map((p) => (p.optional ? <PackCard key={p.id} pack={p} /> : <CorePack key={p.id} pack={p} />))}
      {data ? (
        <p className={s.muted}>
          Packs live in <code>{data.data_dir}\packs</code>. A pack downloaded with <code>pnpm engine packs install</code> in a project folder is a separate
          copy — import it below instead of downloading again.
        </p>
      ) : null}
    </>
  );
}

function CorePack({ pack }: { pack: PackStatus }) {
  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h4>{pack.title}</h4>
          <p className={s.muted}>{pack.description}</p>
        </div>
        <Pill tone={pack.installed ? "ok" : "warn"}>{pack.installed ? "Installed · required" : "Installs on first start"}</Pill>
      </div>
    </section>
  );
}

function PackCard({ pack }: { pack: PackStatus }) {
  const client = useQueryClient();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ["settings"] });
  const run = useMutation({
    mutationFn: async (kind: { install: true } | { import: string } | { remove: true }): Promise<unknown> =>
      "install" in kind ? api.installPack(pack.id) : "import" in kind ? api.importPack(pack.id, kind.import) : api.removePack(pack.id),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (err) => setError(errorText(err)),
  });
  const task = pack.task;
  const busy = isBusy(task) || run.isPending;

  return (
    <section className={s.card} aria-labelledby={`pack-${pack.id}`}>
      <div className={s.cardHead}>
        <div>
          <h4 id={`pack-${pack.id}`}>{pack.title}</h4>
          <p className={s.muted}>
            {pack.description} {pack.license} · about {Math.round(pack.approx_size_mb)} MB to download.
          </p>
        </div>
        <Pill tone={pack.installed ? "ok" : busy ? "warn" : "idle"}>
          {pack.installed ? `Installed · ${mb(pack.size_bytes)} MB` : busy ? "Working…" : "Not installed"}
        </Pill>
      </div>

      {isBusy(task) && task ? <Progress task={task} /> : null}
      {task?.state === "error" ? (
        <div className={s.callout} data-tone="bad" role="alert">
          <CircleAlert size={15} /> <span>{task.error}</span>
        </div>
      ) : null}
      {task?.state === "done" ? (
        <div className={s.callout} data-tone="ok" role="status">
          <Check size={15} /> <span>Ready. Exposure for open incidents has been updated.</span>
        </div>
      ) : null}
      {error ? (
        <div className={s.callout} data-tone="bad" role="alert">
          <CircleAlert size={15} /> <span>{error}</span>
        </div>
      ) : null}

      {!pack.installed && !busy && pack.candidates.length ? (
        <div className={s.found}>
          <div>
            <strong>Found a copy you already downloaded</strong>
            {pack.candidates.map((c) => (
              <div key={c} className={s.foundRow}>
                <code title={c}>{c}</code>
                <button type="button" className={cx(s.btn, s.primary)} onClick={() => run.mutate({ import: c })}>
                  <FolderInput size={14} /> Use this copy
                </button>
              </div>
            ))}
            <p className={s.muted}>Copies it into the app (a few seconds) — no download needed.</p>
          </div>
        </div>
      ) : null}

      {!pack.installed && !busy ? (
        <>
          <div className={s.actions}>
            <button type="button" className={cx(s.btn, !pack.candidates.length && s.primary)} onClick={() => run.mutate({ install: true })}>
              <Download size={14} /> Download (~{Math.round(pack.approx_size_mb)} MB)
            </button>
          </div>
          <form
            className={s.inputRow}
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) run.mutate({ import: path.trim() });
            }}
          >
            <div className={s.inputWrap}>
              <input
                className={s.input}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={`Or import a folder, e.g. C:\\Users\\you\\Desktop\\ATLAS\\data\\runtime\\packs\\${pack.id}`}
                spellCheck={false}
                aria-label={`Folder to import the ${pack.title} from`}
              />
            </div>
            {NATIVE ? (
              <button
                type="button"
                className={s.btn}
                onClick={() =>
                  void pickFolder(`Choose the folder that holds the ${pack.title}`).then((dir) => {
                    if (dir) {
                      setPath(dir);
                      run.mutate({ import: dir });
                    }
                  })
                }
              >
                <FolderInput size={14} /> Choose folder…
              </button>
            ) : null}
            <button type="submit" className={s.btn} disabled={!path.trim()}>
              Import
            </button>
          </form>
        </>
      ) : null}

      {pack.installed && !busy ? (
        <div className={s.actions}>
          <span className={s.muted}>{pack.installed_at ? `Installed ${relTime(pack.installed_at)}` : null}</span>
          <button type="button" className={s.btnGhost} data-tone="bad" onClick={() => run.mutate({ remove: true })}>
            <Trash size={13} /> Remove
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Progress({ task }: { task: PackTask }) {
  const pct = task.total ? Math.min(100, (task.done / task.total) * 100) : null;
  const label =
    task.state === "downloading"
      ? `Downloading · ${mb(task.done)} of ${mb(task.total)} MB`
      : task.state === "copying"
        ? `Copying · ${mb(task.done)} of ${mb(task.total)} MB`
        : task.state === "extracting"
          ? "Extracting the grid…"
          : task.state === "indexing"
            ? "Updating exposure for open incidents…"
            : "Starting…";
  const determinate = pct != null && (task.state === "downloading" || task.state === "copying");
  return (
    <div className={s.progress} role="progressbar" aria-label={label} aria-valuenow={determinate ? Math.round(pct) : undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className={s.progressLabel}>
        <span>{label}</span>
        {determinate ? <span>{Math.round(pct)}%</span> : null}
      </div>
      <div className={s.track}>
        <div className={cx(s.bar, !determinate && s.indeterminate)} style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ appearance */
function AppearanceSection() {
  const surface = useSettings((st) => st.surface);
  const setSurface = useSettings((st) => st.setSurface);
  const ui = useUi();
  const options: { value: Surface; title: string; text: string }[] = [
    { value: "solid", title: "Solid", text: "Opaque panels with stronger text. Easiest to read and lightest on the GPU. Recommended." },
    { value: "glass", title: "Glass", text: "Translucent, blurred panels that let the planet show through. Uses noticeably more GPU." },
  ];
  return (
    <>
      <Header title="Appearance" />
      <div className={s.group} role="radiogroup" aria-label="Panel style">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={surface === o.value}
            className={cx(s.choice, surface === o.value && s.choiceOn)}
            onClick={() => setSurface(o.value)}
          >
            <span className={s.swatch} data-kind={o.value} aria-hidden>
              <span />
            </span>
            <span className={s.choiceText}>
              <strong>{o.title}</strong>
              <span>{o.text}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={s.card}>
        <Toggle checked={ui.highContrast} onChange={ui.setHighContrast} label="High contrast" description="Brighter text and lines everywhere." />
        <Toggle checked={ui.reducedMotion} onChange={ui.setReducedMotion} label="Reduce motion" description="No globe rotation, pulses or camera flights." />
        <Toggle checked={ui.autoRotate} onChange={ui.setAutoRotate} label="Rotate the globe when idle" description="Press R at any time to toggle." />
      </div>
      <PersonalSection />
    </>
  );
}

function LayoutCard() {
  const layout = useSettings((st) => st.layout);
  const setLayout = useSettings((st) => st.setLayout);
  return (
    <section className={s.card}>
      <div className={s.cardHead}>
        <div>
          <h4>Layout</h4>
          <p className={s.muted}>Drag the inner edge of either panel to resize it; double-click it to reset.</p>
        </div>
      </div>
      <div className={s.group} role="radiogroup" aria-label="Layout">
        {(Object.keys(PRESET_WIDTHS) as LayoutPreset[]).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={layout.preset === p}
            className={cx(s.choice, layout.preset === p && s.choiceOn)}
            onClick={() => setLayout({ preset: p, streamW: null, panelW: null })}
          >
            <span className={s.choiceText}>
              <strong>{PRESET_WIDTHS[p].label}</strong>
              <span>{PRESET_WIDTHS[p].hint}</span>
            </span>
          </button>
        ))}
      </div>
      <Toggle checked={layout.swap} onChange={(swap) => setLayout({ swap })} label="Swap sides" description="Intelligence on the left, incident stream on the right." />
    </section>
  );
}

function PersonalSection() {
  const accent = useSettings((st) => st.accent);
  const setAccent = useSettings((st) => st.setAccent);
  const density = useSettings((st) => st.density);
  const setDensity = useSettings((st) => st.setDensity);
  const units = useSettings((st) => st.units);
  const setUnits = useSettings((st) => st.setUnits);
  return (
    <>
      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h4>Accent colour</h4>
            <p className={s.muted}>Used for highlights, focus rings and derived values.</p>
          </div>
        </div>
        <div className={s.swatches} role="radiogroup" aria-label="Accent colour">
          {(Object.keys(ACCENTS) as Accent[]).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={accent === a}
              aria-label={ACCENTS[a].label}
              title={ACCENTS[a].label}
              className={cx(s.swatchBtn, accent === a && s.swatchOn)}
              style={{ "--c": ACCENTS[a].colors[0] } as React.CSSProperties}
              onClick={() => setAccent(a)}
            />
          ))}
        </div>
      </section>
      <LayoutCard />
      <section className={s.card}>
        <div className={s.kv}>
          <span>Density</span>
          <Segmented<Density>
            label="Density"
            size="sm"
            value={density}
            onChange={setDensity}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </div>
        <div className={s.kv}>
          <span>Distances</span>
          <Segmented<Units["distance"]> label="Distance units" size="sm" value={units.distance} onChange={(distance) => setUnits({ distance })} options={[{ value: "km", label: "km" }, { value: "mi", label: "miles" }]} />
        </div>
        <div className={s.kv}>
          <span>Temperature</span>
          <Segmented<Units["temperature"]> label="Temperature units" size="sm" value={units.temperature} onChange={(temperature) => setUnits({ temperature })} options={[{ value: "C", label: "°C" }, { value: "F", label: "°F" }]} />
        </div>
        <div className={s.kv}>
          <span>Wind</span>
          <Segmented<Units["wind"]>
            label="Wind units"
            size="sm"
            value={units.wind}
            onChange={(wind) => setUnits({ wind })}
            options={[{ value: "kt", label: "knots" }, { value: "kmh", label: "km/h" }, { value: "mph", label: "mph" }]}
          />
        </div>
        <p className={s.muted}>Values keep their source units in exports and provenance; only the display converts.</p>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ graphics */
function rendererName(raw: string): string {
  const m = /ANGLE \([^,]+, (.+?)(?: \(0x[0-9a-f]+\))? (?:Direct3D|OpenGL|Vulkan|Metal)/i.exec(raw);
  return m?.[1] ?? raw;
}

function GraphicsSection() {
  const quality = useSettings((st) => st.quality);
  const setQuality = useSettings((st) => st.setQuality);
  const gpu = gpuInfo();
  const name = rendererName(gpu.renderer);
  const integrated = isIntegratedGpu(gpu.renderer);
  const auto = QUALITY[resolveQuality("auto")].label;
  const choices: { value: QualityChoice; label: string; hint: string }[] = [
    {
      value: "auto",
      label: "Automatic",
      hint: `Recommended. Picks from your graphics processor — now: ${auto}${gpu.software ? "" : integrated ? " (integrated graphics)" : " (dedicated GPU)"}.`,
    },
    ...(Object.keys(QUALITY) as (keyof typeof QUALITY)[]).map((k) => ({ value: k, label: QUALITY[k].label, hint: QUALITY[k].hint })),
  ];
  return (
    <>
      <Header title="Graphics">Lower settings make the globe smoother on modest hardware and on battery. Data and numbers are identical at every level.</Header>
      <div className={s.group} role="radiogroup" aria-label="Graphics quality">
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={quality === c.value}
            className={cx(s.choice, quality === c.value && s.choiceOn)}
            onClick={() => setQuality(c.value)}
          >
            <span className={s.choiceText}>
              <strong>{c.label}</strong>
              <span>{c.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <section className={s.card}>
        <div className={s.kv}>
          <span>Graphics processor</span>
          <strong>{gpu.software ? "None — software rendering" : name}</strong>
        </div>
        <div className={s.kv}>
          <span>Window</span>
          <strong>
            {window.innerWidth} × {window.innerHeight} at {window.devicePixelRatio.toFixed(2)}× scaling
          </strong>
        </div>
        <p className={s.muted}>
          The Windows app asks for the high-performance graphics processor, so on laptops with two GPUs the globe runs on the dedicated one.
        </p>
        {gpu.software ? (
          <div className={s.callout} data-tone="warn">
            <CircleAlert size={15} /> <span>No GPU acceleration: the globe uses a reduced profile whatever you choose. Updating your graphics driver usually fixes this.</span>
          </div>
        ) : integrated ? (
          <div className={s.callout} data-tone="warn">
            <Info size={15} />
            <span>Running on integrated graphics. Automatic uses Battery saver here, which keeps the globe smooth.</span>
          </div>
        ) : null}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ about */
function AboutSection({ data }: { data?: AppSettings }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Header title="About & storage" />
      <section className={s.card}>
        <div className={s.kv}>
          <span>ATLAS engine</span>
          <strong>{data ? `v${data.version}` : "…"}</strong>
        </div>
        <div className={s.kv}>
          <span>Data folder</span>
          <span className={s.pathRow}>
            <code>{data?.data_dir ?? "…"}</code>
            {data ? (
              <button
                type="button"
                className={s.copyBtn}
                aria-label="Copy the data folder path"
                onClick={() =>
                  void navigator.clipboard?.writeText(data.data_dir).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  })
                }
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            ) : null}
          </span>
        </div>
        <div className={s.kv}>
          <span>Population grid</span>
          <strong>{data?.population_ready ? "Loaded" : "Not installed"}</strong>
        </div>
      </section>
      <section className={s.card}>
        <p className={s.note}>
          <HardDrive size={14} /> Everything ATLAS stores — the database, caches, packs and your keys — stays in the data folder on this PC. There are no
          accounts and no telemetry. To remove all of it, delete that folder after uninstalling.
        </p>
        <p className={s.note}>
          <CircleAlert size={14} /> ATLAS is a research tool built on open data, not an official warning service. Always follow your local authorities.
        </p>
      </section>
    </>
  );
}
