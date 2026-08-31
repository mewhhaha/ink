# @ink/ui

`@ink/ui` owns the canonical semantic snapshot shared by Blot, browser, and
headless execution. Its stable modules cover semantic identities and nodes,
layout, localization resolution, focus/action control, native browser elements,
and headless observations.

The canvas is never the only representation of meaningful state. Native HTML
preserves reading order, focus, keyboard activation, names, and descriptions;
the same snapshot and actions are used by replay and headless scenarios.
