# @ink/input

The stable input boundary contains typed device samples, action maps, browser
normalization, synthetic sources, and recordings. Browser and headless play map
through the same action definitions, and recordings preserve the normalized
frames needed for deterministic parity checks.

Applications may decide which physical controls they accept, but gameplay reads
semantic actions rather than ambient keyboard or pointer state.
