"""Optional API credentials entered in the desktop app's Settings.

Stored in the data folder as ``credentials.json``. On Windows each value is encrypted with
DPAPI for the current Windows user (``CryptProtectData``), so the file is useless to anyone
else and on another machine; elsewhere it is plain text readable only by the owner. Values
are never logged and never returned by the API — only whether one is set and its last four
characters.

Environment variables (``ATLAS_OPENAQ_API_KEY``…) still win over stored values, so a
developer's ``.env`` keeps working.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("atlas.credentials")


@dataclass(frozen=True)
class CredentialSpec:
    name: str
    env: str
    label: str
    secret: bool
    pattern: re.Pattern[str]


SPECS: dict[str, CredentialSpec] = {
    "openaq_api_key": CredentialSpec(
        "openaq_api_key", "ATLAS_OPENAQ_API_KEY", "OpenAQ API key", True, re.compile(r"[A-Za-z0-9_\-]{16,128}")
    ),
    "reliefweb_appname": CredentialSpec(
        "reliefweb_appname", "ATLAS_RELIEFWEB_APPNAME", "ReliefWeb appname", False, re.compile(r"[A-Za-z0-9._\-]{3,100}")
    ),
}


def validate(name: str, value: str) -> str:
    spec = SPECS.get(name)
    if spec is None:
        raise KeyError(name)
    value = value.strip()
    if not spec.pattern.fullmatch(value):
        raise ValueError(f"That doesn't look like a valid {spec.label}.")
    return value


def hint(value: str | None, secret: bool) -> str | None:
    if not value:
        return None
    return f"…{value[-4:]}" if secret else value


# ------------------------------------------------------------------------- Windows DPAPI
def _dpapi(data: bytes, *, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    fn.argtypes = [
        ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p,
        ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob),
    ]  # fmt: skip
    fn.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buf = ctypes.create_string_buffer(data, len(data))
    entropy_raw = b"ATLAS desktop credentials v1"
    entropy_buf = ctypes.create_string_buffer(entropy_raw, len(entropy_raw))
    src = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    entropy = Blob(len(entropy_raw), ctypes.cast(entropy_buf, ctypes.POINTER(ctypes.c_char)))
    out = Blob()
    ui_forbidden = 0x1  # CRYPTPROTECT_UI_FORBIDDEN
    if not fn(ctypes.byref(src), None, ctypes.byref(entropy), None, None, ui_forbidden, ctypes.byref(out)):
        raise OSError(ctypes.get_last_error(), "DPAPI call failed")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def _encode(value: str) -> str:
    if sys.platform == "win32":
        return "dpapi:" + base64.b64encode(_dpapi(value.encode("utf-8"), protect=True)).decode("ascii")
    return "plain:" + value


def _decode(stored: str) -> str | None:
    kind, _, payload = stored.partition(":")
    try:
        if kind == "dpapi" and sys.platform == "win32":
            return _dpapi(base64.b64decode(payload), protect=False).decode("utf-8")
        if kind == "plain":
            return payload
    except (OSError, ValueError):
        log.warning("a stored credential could not be decrypted (another user or machine?); ignoring it")
    return None


class CredentialStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "credentials.json"

    def _read(self) -> dict[str, str]:
        try:
            raw = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        return {k: v for k, v in raw.items() if k in SPECS and isinstance(v, str)} if isinstance(raw, dict) else {}

    def load(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for name, stored in self._read().items():
            value = _decode(stored)
            if value:
                out[name] = value
        return out

    def set(self, name: str, value: str | None) -> None:
        if name not in SPECS:
            raise KeyError(name)
        data = self._read()
        if value:
            data[name] = _encode(value)
        else:
            data.pop(name, None)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        if sys.platform != "win32":
            tmp.chmod(0o600)
        tmp.replace(self.path)

    def apply_to_environment(self) -> list[str]:
        """Export stored values as ATLAS_* variables unless the environment already sets them."""
        applied = []
        for name, value in self.load().items():
            env = SPECS[name].env
            if not os.environ.get(env):
                os.environ[env] = value
                applied.append(name)
        return applied
