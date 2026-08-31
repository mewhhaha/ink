# Large lighting reference scenes

The lighting lab can load the same external large scenes used by Bevy:

- NVIDIA Amazon Lumberyard Bistro Exterior (CC BY 4.0)
- Activision Caldera Hotel 01 (Activision non-commercial license)

Run `pnpm sync:lighting-scenes` to download and convert both models. The source
GLB files are intentionally ignored because they are large and retain their
upstream licenses. `pnpm --filter @ink/lighting-dev prepare:assets` parses them
at build time and publishes only digest-addressed mesh, material, and texture
chunks to the browser.

Activision's Caldera release deliberately excludes textures and materials. Ink
retains the hotel geometry as published and does not generate a masonry
substitute. If a future pinned source includes material images, the converter
requires every referenced image to exist and embeds those images in the prepared
texture chunks.
