# Design System

**Intent:** a planetary instrument. Scientific, precise, quietly futuristic. The Earth is
the hero; chrome recedes. Premium means restraint: no neon, no glow spam, glass only where
something real (the planet) is behind it.

Tokens live in [`apps/web/src/styles/tokens.css`](../apps/web/src/styles/tokens.css).

## Colour

| Role | Token | Value |
|---|---|---|
| Void / background | `--void`, `--bg` | `#04060a`, `#070a0f` |
| Surfaces | `--surface-1…4` | `#0a0e14` → `#1a222e` |
| Floating glass | `--glass` | `rgba(9,13,19,.72)` + 22 px blur |
| Hairlines | `--line-1…3` | slate at 8 / 14 / 24 % |
| Text | `--text-1…4` | `#e8ecf2` → `#4a5463` |
| Signal accent (atmospheric limb) | `--accent` | `#9cc9ff` — focus, selection, live state only |

### Hazards — colour **and** glyph
Each hazard has a hue and a unique 24×24 line glyph shared by DOM icons and WebGL sprites,
so meaning never depends on colour alone (WCAG 1.4.1).

| Hazard | Colour | Glyph |
|---|---|---|
| Earthquake | `#f2b84b` amber | concentric ripples |
| Tropical cyclone | `#a08cff` violet | spiral arms |
| Wildfire | `#ff6b3d` flame | flame |
| Flood | `#3ea8f2` water | waves |
| Volcano | `#f0507f` magma | cone + plume |
| Drought | `#c9a26b` ochre | sun with fissure |

### Severity — luminance + tick count
`1 #7d8899 → 5 #ff3d71`, always drawn as 1–5 rising bars (meter) or ticks around the map
marker, so severity reads in greyscale and for all common colour-vision deficiencies.

### Provenance
Observed `#8fd8b8` · Derived `#9cc9ff` · Model `#d6b6ff` · Simulation `#ffb86b` ·
Unavailable `#6f7a8a`, with a three-letter code (OBS/DRV/MDL/SIM/N/A).

## Typography
- **IBM Plex Sans Variable** for UI — engineered, neutral, excellent at small sizes.
- **IBM Plex Mono** with `tabular-nums slashed-zero` for every number that updates, so
  values never jitter.
- Scale: 10.5 / 11.5 / 12.5 / 13.5 / 15 / 18 / 24 / 34 / 48 px. Micro-labels are uppercase,
  10.5 px, `0.09em` tracking.
- Large numerals (hero counts, temperatures) use weight 200–300 for an instrument feel.

## Space, radius, elevation
4 px grid (`--s-1…12`); radii 4/6/10/14/20; three elevation recipes combining an inner
1 px highlight with soft long shadows.

## Layout
Full-bleed globe; floating rails: incident stream (372 px), context panel (420 px), timeline
(64 px), all with 12 px gutters. Ultrawide widens rails; laptops narrow them; tablets
compress; phones become a focused event viewer (globe + bottom sheet).

## Motion
- Easing: `--ease-out` `cubic-bezier(.16,1,.3,1)`, spring presets in Motion.
- Durations 120 / 200 / 320 / 520 ms. Everything collapses to 0 under reduced motion
  (system setting or in-app toggle) — including globe rotation and pulse rings.
- Motion always communicates state: pulses mark recent severe activity, numbers glide to
  new values, panels morph on selection, the camera flies to what you chose.
- Rendering is on demand; no animation blocks input.

## Components (all custom)
Severity meter · provenance badge · confidence meter · hazard glyph · incident card ·
segmented control · toggle · icon button · sparkline · skeleton rows · empty and error
states · command palette · layer manager with legends · timeline histogram · hover cards ·
toasts · error boundaries with designed fallbacks.

## Accessibility
Keyboard-first (⌘/Ctrl K, `/`, `L`, `R`, `H`, `+/-`, `[`/`]`, `Alt+1–3`, `j/k`, `Esc`),
visible focus rings, ARIA roles for listbox/tabs/dialogs, live regions for streaming
updates, skip link, high-contrast mode, reduced motion.
