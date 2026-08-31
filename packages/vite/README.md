# @ink/vite

`@ink/vite` provides language-neutral application configuration, browser update
messages, and the client connection used by focused development applications. It
owns watching, rebuild scheduling, and browser notification, while each source
adapter owns how an artifact is compiled.

Blot compiler configuration, retained units, and atomic activation belong to
`@ink/blot`; Vite does not duplicate compiler or runtime policy.
