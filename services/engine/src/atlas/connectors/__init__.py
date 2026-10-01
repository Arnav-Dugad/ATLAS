"""Connector registry. Add a new source by implementing DataConnector and listing it here."""

from __future__ import annotations

from atlas.connectors.base import (
    Capability,
    ConnectorContext,
    DataConnector,
    DetectionFile,
    FetchOutcome,
    Job,
)
from atlas.connectors.emsc import EmscConnector
from atlas.connectors.eonet import EonetConnector
from atlas.connectors.firms import FirmsConnector
from atlas.connectors.gdacs import GdacsConnector
from atlas.connectors.gvp import GvpConnector
from atlas.connectors.nhc import NhcConnector
from atlas.connectors.reliefweb import ReliefWebConnector
from atlas.connectors.tsunami import TsunamiConnector
from atlas.connectors.usgs import UsgsConnector

CONNECTORS: list[type[DataConnector]] = [
    UsgsConnector,
    EmscConnector,
    TsunamiConnector,
    GdacsConnector,
    NhcConnector,
    EonetConnector,
    GvpConnector,
    FirmsConnector,
    ReliefWebConnector,
]

__all__ = [
    "CONNECTORS",
    "Capability",
    "ConnectorContext",
    "DataConnector",
    "DetectionFile",
    "FetchOutcome",
    "Job",
]
