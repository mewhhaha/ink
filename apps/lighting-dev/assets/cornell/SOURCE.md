# Cornell box reference

The room follows the Cornell Program of Computer Graphics benchmark described at
[The Cornell Box](https://bowers.cornell.edu/cornell-box). Ink converts the
published millimeter coordinates to meters.

| Element          | Coordinates used by Ink                              |
| ---------------- | ---------------------------------------------------- |
| Room             | 0.5528 m wide, 0.5488 m high, 0.5592 m deep          |
| Camera           | `(0.278, 0.273, -0.800)` m, facing positive z        |
| Ceiling emitter  | x `0.213..0.343` m, y `0.5488` m, z `0.227..0.332` m |
| Green right wall | x `0` m                                              |
| Red left wall    | x `0.5528` m                                         |

The rough metal sphere, mirror, and blue object behind the camera extend the
benchmark scene to exercise glossy reflection, ideal reflection, and retention
of geometry that only a reflected ray can see.
