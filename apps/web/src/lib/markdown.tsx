/**
 * Minimal, safe markdown for assistant answers: paragraphs, headings, bullet and numbered
 * lists, **bold**, *italic*, `code`. It builds React elements only — never HTML — so model
 * output (which may echo feed text) cannot inject markup. Links are shown as text.
 * Incident ids (ATL-XX-YYYY-XXXXXXXX) become buttons via `renderRef`.
 */
import { Fragment, type ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[?ATL-[A-Z]{2}-\d{4}-[A-Z0-9]{8}\]?)/g;
const REF = /^\[?(ATL-[A-Z]{2}-\d{4}-[A-Z0-9]{8})\]?$/;

export type RefRenderer = (id: string, key: string) => ReactNode;

function inline(text: string, renderRef: RefRenderer, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${i++}`;
    const ref = REF.exec(tok);
    if (ref) out.push(renderRef(ref[1]!, key));
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, renderRef }: { text: string; renderRef: RefRenderer }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let k = 0;

  const flushPara = () => {
    if (para.length) {
      const key = `p${k++}`;
      blocks.push(<p key={key}>{inline(para.join(" "), renderRef, key)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `l${k++}`;
      const items = list.items.map((it, j) => <li key={`${key}-${j}`}>{inline(it, renderRef, `${key}-${j}`)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]!);
    } else if (heading) {
      flushPara();
      flushList();
      const key = `h${k++}`;
      blocks.push(
        <p key={key} className="md-heading">
          <strong>{inline(heading[1]!, renderRef, key)}</strong>
        </p>,
      );
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <Fragment>{blocks}</Fragment>;
}
