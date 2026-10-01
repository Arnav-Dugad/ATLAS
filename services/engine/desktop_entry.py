"""PyInstaller entry point for the desktop sidecar (see apps/desktop and .github/workflows/desktop.yml)."""

from atlas.desktop import main

raise SystemExit(main())
