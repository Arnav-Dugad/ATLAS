"""Retrieval over ATLAS's own documentation (methodology, data sources, simulation, AI notes).

Plain BM25 over heading-delimited sections: deterministic, dependency-free, fast, and good
enough for "how is severity determined?"-style questions. No embedding model is required.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

DOCS = ("METHODOLOGY.md", "DATA_SOURCES.md", "SIMULATION.md", "AI.md", "SECURITY.md")
_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = frozenset((
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it", "of", "on", "or", "that",
    "the", "this", "to", "was", "what", "when", "where", "which", "who", "why", "with", "does", "do",
))  # fmt: skip


def tokens(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOP and len(t) > 1]


@dataclass(frozen=True)
class Section:
    doc: str
    heading: str
    text: str


def split_sections(doc: str, markdown: str, max_chars: int = 1400) -> list[Section]:
    out: list[Section] = []
    heading = doc
    buf: list[str] = []

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body:
            for i in range(0, len(body), max_chars):
                out.append(Section(doc, heading, body[i : i + max_chars]))
        buf.clear()

    for line in markdown.splitlines():
        if line.startswith("#"):
            flush()
            heading = line.lstrip("#").strip() or heading
        else:
            buf.append(line)
    flush()
    return out


class DocsIndex:
    def __init__(self, sections: list[Section]) -> None:
        self.sections = sections
        self.docs = [Counter(tokens(f"{s.heading} {s.heading} {s.text}")) for s in sections]
        self.lengths = [sum(d.values()) for d in self.docs]
        self.avg = (sum(self.lengths) / len(self.lengths)) if self.lengths else 1.0
        df: Counter[str] = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    @classmethod
    def from_dir(cls, root: Path) -> DocsIndex:
        sections: list[Section] = []
        for name in DOCS:
            p = root / name
            if p.is_file():
                sections += split_sections(name, p.read_text("utf-8"))
        return cls(sections)

    def search(self, query: str, k: int = 3) -> list[tuple[float, Section]]:
        q = tokens(query)
        if not q or not self.sections:
            return []
        k1, b = 1.5, 0.75
        scored: list[tuple[float, Section]] = []
        for doc, length, sec in zip(self.docs, self.lengths, self.sections, strict=True):
            s = 0.0
            for t in q:
                f = doc.get(t, 0)
                if f:
                    s += self.idf.get(t, 0.0) * f * (k1 + 1) / (f + k1 * (1 - b + b * length / self.avg))
            if s > 0:
                scored.append((s, sec))
        scored.sort(key=lambda x: -x[0])
        return scored[:k]
