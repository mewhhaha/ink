import argparse
import json
import pathlib
import sys

import bpy


parser = argparse.ArgumentParser()
parser.add_argument("source", type=pathlib.Path)
parser.add_argument("destination", type=pathlib.Path)
parser.add_argument("--report", type=pathlib.Path, required=True)
texture_options = parser.add_mutually_exclusive_group()
texture_options.add_argument("--strip-textures", action="store_true")
texture_options.add_argument("--texture-size", type=int)
arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])

source = arguments.source.resolve()
destination = arguments.destination.resolve()
report = arguments.report.resolve()
if not source.is_file():
    raise RuntimeError(f"reference scene source does not exist: {source}")
if destination.suffix.lower() != ".glb":
    raise RuntimeError(f"reference scene destination must end in .glb: {destination}")

bpy.ops.wm.read_factory_settings(use_empty=True)
if source.suffix.lower() == ".fbx":
    from io_scene_fbx import import_fbx

    read_fbx_light = import_fbx.blen_read_light

    def read_fbx_light_without_removed_cycles_property(*args, **kwargs):
        try:
            return read_fbx_light(*args, **kwargs)
        except AttributeError as error:
            if "cast_shadow" not in str(error):
                raise
            return bpy.data.lights[-1]

    import_fbx.blen_read_light = read_fbx_light_without_removed_cycles_property
    bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)
elif source.suffix.lower() in {".usd", ".usda", ".usdc"}:
    bpy.ops.wm.usd_import(
        filepath=str(source),
        import_cameras=False,
        import_lights=False,
        import_materials=True,
    )
else:
    raise RuntimeError(f"unsupported reference scene source: {source}")

for scene_object in tuple(bpy.data.objects):
    if scene_object.type in {"CAMERA", "LIGHT"}:
        bpy.data.objects.remove(scene_object, do_unlink=True)

mesh_object_count = sum(1 for scene_object in bpy.data.objects if scene_object.type == "MESH")
if mesh_object_count == 0:
    raise RuntimeError(f"reference scene contains no mesh objects: {source}")

missing_images = []
for image in bpy.data.images:
    if image.packed_file is not None or image.source != "FILE":
        continue
    image_path = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
    if not image_path.is_file():
        missing_images.append(f"{image.name}: {image_path}")
if missing_images:
    raise RuntimeError(
        "reference scene has missing material images:\n" + "\n".join(missing_images)
    )

if arguments.texture_size is not None and arguments.texture_size <= 0:
    raise RuntimeError(
        f"reference texture size must be positive: {arguments.texture_size}"
    )

if arguments.strip_textures:
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in tuple(material.node_tree.nodes):
            if node.type == "TEX_IMAGE":
                material.node_tree.nodes.remove(node)
elif arguments.texture_size is not None:
    retained_images = set()
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        retained_nodes = set()

        def retain_linked_images(socket):
            pending = [link.from_node for link in socket.links]
            visited = set()
            while pending:
                node = pending.pop()
                if node in visited:
                    continue
                visited.add(node)
                if node.type == "TEX_IMAGE":
                    retained_nodes.add(node)
                    retained_images.add(node.image)
                for node_input in node.inputs:
                    pending.extend(link.from_node for link in node_input.links)

        for node in material.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            for input_name in (
                "Base Color",
                "Metallic",
                "Roughness",
                "Normal",
                "Emission Color",
                "Alpha",
            ):
                node_input = node.inputs.get(input_name)
                if node_input is not None:
                    retain_linked_images(node_input)
        for node in tuple(material.node_tree.nodes):
            if node.type == "TEX_IMAGE" and node not in retained_nodes:
                material.node_tree.nodes.remove(node)
    for image in retained_images:
        longest_edge = max(image.size)
        if longest_edge <= arguments.texture_size:
            continue
        scale = arguments.texture_size / longest_edge
        image.scale(
            max(1, round(image.size[0] * scale)),
            max(1, round(image.size[1] * scale)),
        )

destination.parent.mkdir(parents=True, exist_ok=True)
report.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(destination),
    export_format="GLB",
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
)
report.write_text(
    json.dumps(
        {
            "image_count": len(bpy.data.images),
            "material_count": len(bpy.data.materials),
            "mesh_object_count": mesh_object_count,
            "source": str(source),
        },
        indent=2,
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
print(f"converted {source} to {destination}")
