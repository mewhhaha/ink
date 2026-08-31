# Caldera hotel reference

`CalderaHotel.glb` is converted from Activision's Caldera data set at revision
`03feaa1886c0a39bc50ca0df86c321f74ed4eee6`.

The upstream release explicitly excludes textures and materials. Ink retains the
actual hotel geometry graph and its authored geometry attributes. It does not
generate replacement textures or claim texture fidelity that the source does not
provide.

The sync tool resolves the hotel's recursive USD dependency closure and runs
`usdchecker` before Blender conversion. Missing referenced geometry stops the
conversion with the unresolved path.

https://github.com/Activision/caldera/tree/03feaa1886c0a39bc50ca0df86c321f74ed4eee6/map_source/prefabs/br/wz_vg/mp_wz_island/commercial/hotel_01
