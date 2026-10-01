"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from atlas import __version__
from atlas.api.routes import router
from atlas.api.service import QueryService
from atlas.config import Settings, get_settings
from atlas.observability import configure_logging, metrics
from atlas.runtime import Runtime

log = logging.getLogger("atlas.api")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime = Runtime(settings)
        app.state.runtime = runtime
        app.state.service = QueryService(runtime)
        await runtime.start()
        log.info("ATLAS engine %s listening on http://%s:%d", __version__, settings.host, settings.port)
        try:
            yield
        finally:
            await runtime.stop()

    app = FastAPI(
        title="ATLAS Engine API",
        version=__version__,
        description="Planetary disaster intelligence: normalised, correlated, provenance-tracked open data.",
        lifespan=lifespan,
    )
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
        max_age=3600,
    )

    @app.middleware("http")
    async def timing_and_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        t0 = time.perf_counter()
        response = await call_next(request)
        elapsed = (time.perf_counter() - t0) * 1000
        route = request.scope.get("route")
        name = getattr(route, "path", request.url.path)
        if not name.endswith("/stream"):
            metrics.observe(f"api.latency_ms.{name}", elapsed)
            response.headers["Server-Timing"] = f"app;dur={elapsed:.1f}"
        metrics.inc(f"api.status.{response.status_code // 100}xx")
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": {"code": "invalid_request", "message": "Invalid request parameters",
                                         "fields": [".".join(str(p) for p in e["loc"]) for e in exc.errors()]}}, status_code=422)  # fmt: skip

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error: %s", exc)
        # Never leak stack traces to clients.
        return JSONResponse({"error": {"code": "internal", "message": "Internal error. See engine logs."}}, status_code=500)

    app.include_router(router)
    return app
