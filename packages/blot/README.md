# @ink/blot

`@ink/blot` adapts Blot compiler artifacts to Ink's language-neutral runtime.
One ABI registry generates the Blot host declarations, manifest validation,
required exports, TypeScript codecs, and executable ABI fixture.

The stable surface contains the guest adapter, production build boundary,
integer data-asset parser, runtime adapter, canonical protocol, and reusable
Blot modules for data, ECS, engine phases, semantic HTML, math, and scenes.
Games own their rules and state; this package owns only game-neutral
capabilities.

Development-profile compilation and atomic retained-unit activation are
implementation details used by the Vite integration. A failed prepared build or
activation leaves the last committed guest graph executable.
