# @ink/localization plan

Status: implemented.

## Purpose

Resolve authored message catalogs and localized assets consistently across game
UI, dialogue, subtitles, accessibility surfaces, and headless execution.

## Ownership

This package owns canonical locale identities, catalog fallback, structured
message patterns, argument substitution, select and plural rules, number and
date formatting, and localized asset selection. It does not own UI trees, fonts,
text shaping, dialogue rules, or storage policy.

## Acceptance

- [x] Resolve exact, language, and configured fallback catalogs in a stable
      order while reporting every attempted locale on failure.
- [x] Format arguments, numbers, dates, selects, and cardinal or ordinal plurals
      without evaluating catalog source as code.
- [x] Select localized assets using the same fallback rules and reject kind
      mismatches at catalog construction.
- [x] Expose a resolver contract consumed directly by `@ink/ui`.
