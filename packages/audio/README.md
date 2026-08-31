# @ink/audio

The audio package maps ordered presentation commands to an immutable mix plan,
then applies that plan through an optional Web Audio device. Device activation,
suspension, interruption, recovery, graph replacement, and native failures are
explicit outcomes; unavailable audio never stops gameplay or semantic UI.

Applications install decoded clips from `@ink/assets`, compile a bus graph, map
their presentation clock once through `AudioMixer`, and submit ready plans to
`AudioDevice`. Spatial playback uses the shared right-handed, Y-up coordinates
and converts emitter and listener state before commands reach the mixer.
Adventure proves `spatial.ts` with key, moving-gate, and exit emitters derived
from Blot presentation positions and camera intent; the resulting gain, pan, and
Doppler values reach the submitted voice plan.

The bounded stream buffer remains under `experimental/stream.ts`. Stream sources
are not part of the stable command, mixer, or Web Audio contracts until an
editor game proves real streamed playback.
