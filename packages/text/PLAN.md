# @ink/text plan

Status: implemented.

## Purpose

Describe font assets and lay out text for world labels, subtitles, HUDs, and
editor previews without coupling shaping to a renderer.

## Ownership

This package owns font-family definitions, text styles, wrapping, alignment,
direction, measured line layout, the browser canvas measurement adapter, and a
typed world-text scene attachment. It does not own localization catalogs,
semantic UI, glyph rasterization, GPU atlases, or scene transforms.

Browser text measurement and shaping are explicit capabilities. Core layout is
pure for a supplied measurer, so headless tests and non-browser hosts can
provide equivalent metrics.

## Acceptance

- [x] Validate font families and styles with evidence naming invalid values.
- [x] Wrap and align measured text with explicit overflow and direction.
- [x] Provide browser canvas measurement without making a canvas ambient state.
- [x] Attach validated fixed or billboard text to ordinary scene nodes.
