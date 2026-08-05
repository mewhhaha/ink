# Freedoom Phase 1 asset pack

This directory contains the official Freedoom 0.13.0 release selected for the
Doom renderer work in this app.

Freedoom is a free/libre replacement for the proprietary Doom game data. The
WAD files include the graphics, sprites, textures, sound effects, music, maps,
and related metadata needed by a compatible Doom renderer. They are **not**
the original id Software Doom artwork or audio.

## Files

- `release/freedoom-0.13.0/freedoom1.wad` — Phase 1 / Ultimate Doom-compatible data
- `release/freedoom-0.13.0/freedoom2.wad` — Phase 2 data
- `release/freedoom-0.13.0/COPYING.txt` — license text
- `release/freedoom-0.13.0/CREDITS.txt` — project credits
- `release/freedoom-0.13.0/CREDITS-MUSIC.txt` — music credits
- `freedoom-0.13.0.zip` — downloaded release archive retained for provenance

The manuals and release notes are kept in the extracted release directory as
well.

## Provenance

- Project: Freedoom
- Release: `0.13.0`
- Download source: the official Freedoom GitHub release
- Archive SHA-256: `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`
- `freedoom1.wad` SHA-256: `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d`
- `freedoom2.wad` SHA-256: `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b`

Keep the license and credits files with any redistribution. The next
implementation step is to add a WAD reader and decode these lumps into the
Blot/canvas resource path; no browser audio or image files have been generated
from the WADs yet.
>>>>>>