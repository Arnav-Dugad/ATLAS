"""Text utilities: sanitisation of untrusted upstream content and name normalisation."""

from __future__ import annotations

import html
import re
import unicodedata
from html.parser import HTMLParser

_WS = re.compile(r"\s+")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class _TextExtractor(HTMLParser):
    """Collects visible text only; script/style content is discarded entirely."""

    _SKIP = frozenset({"script", "style", "iframe", "object", "embed", "noscript", "template"})
    _BREAK = frozenset({"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BREAK:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)


def html_to_text(value: str | None, max_len: int = 4000) -> str:
    """Reduce untrusted HTML to plain text. Never returns markup."""
    if not value:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(value)
        parser.close()
        text = "".join(parser.parts)
    except Exception:  # malformed markup: fall back to escaping everything
        text = html.unescape(re.sub(r"<[^>]*>", " ", value))
    return clean_text(text, max_len)


def clean_text(value: str | None, max_len: int = 4000) -> str:
    if not value:
        return ""
    text = unicodedata.normalize("NFC", value)
    text = _CONTROL.sub("", text)
    text = _WS.sub(" ", text).strip()
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


_NAME_NOISE = re.compile(
    r"\b(tropical|storm|cyclone|hurricane|typhoon|depression|super|severe|post|potential|"
    r"remnants? of|subtropical|invest|ts|td|hu|ty|stc)\b",
    re.IGNORECASE,
)
_YEAR_SUFFIX = re.compile(r"[-\s]?\d{2,4}$")


def normalize_storm_name(name: str | None) -> str:
    """'Tropical Storm Hanna' / 'HANNA-26' / 'Hurricane HANNA' -> 'hanna'."""
    if not name:
        return ""
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    text = _YEAR_SUFFIX.sub("", text.strip())
    text = _NAME_NOISE.sub(" ", text)
    text = re.sub(r"[^a-zA-Z0-9 ]", " ", text)
    return _WS.sub(" ", text).strip().lower()


def slug(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")
