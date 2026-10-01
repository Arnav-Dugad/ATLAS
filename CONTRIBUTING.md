# Contributing to ATLAS

Thank you for helping build an open planetary intelligence layer.

## Ground rules
1. **No fake data.** Never add synthetic events, placeholder metrics or random series to
   make a view look populated. Tests may use synthetic fixtures, clearly labelled as such.
2. **Provenance on every number.** New metrics declare `real`, `derived`, `model`,
   `simulation` or `unavailable`, plus source and method.
3. **Respect licences.** New sources need a registry entry with licence, attribution and
   limits, and a verification note in `docs/DATA_SOURCES.md`.
4. **Be a good citizen.** Cache, revalidate, back off. Never poll faster than a source updates.

## Development
```bash
pnpm setup
pnpm dev
pnpm test          # web + engine
pnpm lint
pnpm typecheck
pnpm gen:api       # after changing API schemas
```

Engine style: `ruff format` + `ruff check`, typed code, tests under `services/engine/tests`
with real-payload fixtures. Web style: strict TypeScript, ESLint (incl. jsx-a11y), CSS
modules on top of design tokens — no ad-hoc colours.

## Commits
Conventional, meaningful messages (`feat(engine): …`, `fix(web): …`). Keep commits focused.
