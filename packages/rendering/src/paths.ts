import { type CompiledRenderGraph, RenderGraph } from "./graph.ts";
import type { DrawPacket, RenderWorld } from "./extraction.ts";
import {
  render_quality_profile,
  type RenderQualityProfile,
  type RenderSurface,
} from "./model.ts";
import { plan_upscaling, type UpscalingPlan } from "./upscaling.ts";
import { scene_node_key } from "@ink/scene/identity.ts";
import {
  lighting_plan_for_path,
  type LightingPlan,
} from "@ink/lighting/plan.ts";

const texture_usage = {
  sampled: 0x04,
  storage: 0x08,
  attachment: 0x10,
} as const;
const buffer_usage = { storage: 0x80, indirect: 0x100 } as const;

export interface RenderingPathPlan {
  readonly path: RenderQualityProfile["path"];
  readonly graph: CompiledRenderGraph;
  readonly packets: readonly DrawPacket[];
  readonly object_id_by_draw: readonly string[];
  readonly lighting: LightingPlan;
  readonly upscaling: UpscalingPlan;
  readonly quality_differences: readonly string[];
}

export function build_rendering_path(
  profile: RenderQualityProfile,
  surface: RenderSurface,
  world: RenderWorld,
  packets: readonly DrawPacket[],
): RenderingPathPlan {
  const quality = render_quality_profile(profile);
  const upscaling = plan_upscaling(quality.upscaling, surface);
  const graph = base_graph(quality, surface, upscaling);
  if (quality.path === "compatibility") compatibility_passes(graph, quality);
  else if (quality.path === "clustered_forward") {
    clustered_forward_passes(graph, quality);
  } else deferred_passes(graph, quality, upscaling);
  post_processing_passes(graph, quality, surface, upscaling);
  const accepted = new Set(
    world.renderables.map((renderable) => scene_node_key(renderable.node)),
  );
  for (const packet of packets) {
    if (!accepted.has(scene_node_key(packet.object))) {
      throw new Error(
        `render draw object ${
          scene_node_key(packet.object)
        } is absent from render world revision ${world.scene_revision}`,
      );
    }
  }
  return {
    path: quality.path,
    graph: graph.compile(),
    packets: [...packets],
    object_id_by_draw: packets.map((packet) => scene_node_key(packet.object)),
    lighting: lighting_plan_for_path(world.lighting, quality.path),
    upscaling,
    quality_differences: differences(quality.path),
  };
}

function base_graph(
  profile: RenderQualityProfile,
  surface: RenderSurface,
  upscaling: UpscalingPlan,
): RenderGraph {
  const graph = new RenderGraph();
  graph.resource({
    id: "surface",
    lifetime: "external",
    descriptor: {
      type: "texture",
      width: surface.width,
      height: surface.height,
      depth_or_layers: 1,
      mip_levels: 1,
      sample_count: 1 as const,
      format: surface.format,
      usage: texture_usage.attachment,
    },
  });
  graph.resource({
    id: "depth",
    lifetime: "transient",
    descriptor: {
      type: "texture",
      width: upscaling.render_extent.width,
      height: upscaling.render_extent.height,
      depth_or_layers: 1,
      mip_levels: 1,
      sample_count: profile.sample_count,
      format: "depth32float",
      usage: texture_usage.attachment | texture_usage.sampled,
    },
  });
  graph.resource({
    id: "hdr",
    lifetime: "transient",
    descriptor: {
      type: "texture",
      width: upscaling.render_extent.width,
      height: upscaling.render_extent.height,
      depth_or_layers: 1,
      mip_levels: 1,
      sample_count: 1 as const,
      format: profile.hdr_format,
      usage: texture_usage.attachment | texture_usage.sampled |
        texture_usage.storage,
    },
  });
  if (profile.sample_count === 4) {
    graph.resource({
      id: "hdr_msaa",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: upscaling.render_extent.width,
        height: upscaling.render_extent.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 4,
        format: profile.hdr_format,
        usage: texture_usage.attachment,
      },
    });
  }
  if (profile.upscaling.type === "fsr2") {
    graph.resource({
      id: "motion_vectors",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: upscaling.render_extent.width,
        height: upscaling.render_extent.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format: "rg16float",
        usage: texture_usage.attachment | texture_usage.sampled,
      },
    });
  }
  graph.pass({
    id: "depth_prepass",
    kind: "render",
    reads: [],
    writes: [{
      resource: "depth",
      access: "attachment",
      load: "clear",
      store: "store",
    }],
    after: [],
  });
  return graph;
}

function compatibility_passes(
  graph: RenderGraph,
  profile: RenderQualityProfile,
): void {
  graph.pass({
    id: "compatibility_forward",
    kind: "render",
    reads: [{ resource: "depth", access: "sampled" }],
    writes: color_writes(profile),
    after: ["depth_prepass"],
  });
}

function clustered_forward_passes(
  graph: RenderGraph,
  profile: RenderQualityProfile,
): void {
  graph.resource({
    id: "light_clusters",
    lifetime: "transient",
    descriptor: {
      type: "buffer",
      size_bytes: Math.max(256, profile.maximum_lights * 64),
      usage: buffer_usage.storage,
    },
  });
  graph.pass({
    id: "cluster_lights",
    kind: "compute",
    reads: [{ resource: "depth", access: "sampled" }],
    writes: [{
      resource: "light_clusters",
      access: "storage_write",
      load: "discard",
      store: "store",
    }],
    after: ["depth_prepass"],
  });
  graph.pass({
    id: "clustered_forward",
    kind: "render",
    reads: [{ resource: "depth", access: "sampled" }, {
      resource: "light_clusters",
      access: "storage_read",
    }],
    writes: color_writes(profile),
    after: ["cluster_lights"],
  });
}

function deferred_passes(
  graph: RenderGraph,
  profile: RenderQualityProfile,
  upscaling: UpscalingPlan,
): void {
  for (
    const [id, format] of [
      ["gbuffer_base", "rgba8unorm-srgb"],
      ["gbuffer_normal", "rgba16float"],
      ["gbuffer_material", "rgba8unorm"],
      ["object_ids", "r32uint"],
    ] as const
  ) {
    graph.resource({
      id,
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: upscaling.render_extent.width,
        height: upscaling.render_extent.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format,
        usage: texture_usage.attachment | texture_usage.sampled,
      },
    });
  }
  graph.pass({
    id: "gbuffer",
    kind: "render",
    reads: [{ resource: "depth", access: "sampled" }],
    writes: [
      "gbuffer_base",
      "gbuffer_normal",
      "gbuffer_material",
      "object_ids",
      ...(profile.upscaling.type === "fsr2" ? ["motion_vectors"] : []),
    ]
      .map((resource) => ({
        resource,
        access: "attachment" as const,
        load: "clear" as const,
        store: "store" as const,
      })),
    after: ["depth_prepass"],
  });
  graph.pass({
    id: "deferred_lighting",
    kind: "render",
    reads: ["depth", "gbuffer_base", "gbuffer_normal", "gbuffer_material"].map((
      resource,
    ) => ({ resource, access: "sampled" as const })),
    writes: [{
      resource: "hdr",
      access: "attachment",
      load: "clear",
      store: "store",
    }],
    after: ["gbuffer"],
  });
  graph.pass({
    id: "deferred_transparent",
    kind: "render",
    reads: [{ resource: "depth", access: "sampled" }],
    writes: [{
      resource: "hdr",
      access: "attachment",
      load: "load",
      store: "store",
    }],
    after: ["deferred_lighting"],
  });
}

function post_processing_passes(
  graph: RenderGraph,
  profile: RenderQualityProfile,
  surface: RenderSurface,
  upscaling: UpscalingPlan,
): void {
  let input = "hdr";
  let after = profile.path === "compatibility"
    ? "compatibility_forward"
    : profile.path === "clustered_forward"
    ? "clustered_forward"
    : "deferred_transparent";
  if (profile.anti_aliasing === "taa") {
    graph.resource({
      id: "taa",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: upscaling.render_extent.width,
        height: upscaling.render_extent.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format: "rgba16float",
        usage: texture_usage.sampled | texture_usage.storage,
      },
    });
    graph.pass({
      id: "taa",
      kind: "compute",
      reads: [{ resource: input, access: "sampled" }],
      writes: [{
        resource: "taa",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    input = "taa";
    after = "taa";
  }
  if (profile.upscaling.type === "fsr1") {
    graph.resource({
      id: "fsr1_easu",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: surface.width,
        height: surface.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format: "rgba16float",
        usage: texture_usage.sampled | texture_usage.storage,
      },
    });
    graph.pass({
      id: "fsr1_easu",
      kind: "compute",
      reads: [{ resource: input, access: "sampled" }],
      writes: [{
        resource: "fsr1_easu",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    graph.resource({
      id: "fsr1_output",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: surface.width,
        height: surface.height,
        depth_or_layers: 1,
        mip_levels: 1,
        sample_count: 1,
        format: "rgba16float",
        usage: texture_usage.sampled | texture_usage.storage,
      },
    });
    graph.pass({
      id: "fsr1_rcas",
      kind: "compute",
      reads: [{ resource: "fsr1_easu", access: "sampled" }],
      writes: [{
        resource: "fsr1_output",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["fsr1_easu"],
    });
    input = "fsr1_output";
    after = "fsr1_rcas";
  }
  if (profile.upscaling.type === "fsr2") {
    const display_texture = {
      type: "texture" as const,
      width: surface.width,
      height: surface.height,
      depth_or_layers: 1,
      mip_levels: 1,
      sample_count: 1 as const,
      format: "rgba16float" as const,
      usage: texture_usage.sampled | texture_usage.storage,
    };
    graph.resource({
      id: "fsr2_color_history",
      lifetime: "external",
      initial_content: "present",
      descriptor: display_texture,
    });
    graph.resource({
      id: "fsr2_depth_history",
      lifetime: "external",
      initial_content: "present",
      descriptor: {
        ...display_texture,
        format: "r32float",
      },
    });
    for (
      const [id, format] of [
        ["fsr2_reactive_mask", "r32float"],
        ["fsr2_luminance", "r32float"],
        ["fsr2_reconstructed", "rgba16float"],
        ["fsr2_depth_clip", "r32float"],
        ["fsr2_locks", "r32float"],
        ["fsr2_accumulated", "rgba16float"],
        ["fsr2_output", "rgba16float"],
      ] as const
    ) {
      graph.resource({
        id,
        lifetime: "transient",
        descriptor: { ...display_texture, format },
      });
    }
    graph.resource({
      id: "fsr2_color_history_next",
      lifetime: "external",
      descriptor: display_texture,
    });
    graph.resource({
      id: "fsr2_depth_history_next",
      lifetime: "external",
      descriptor: { ...display_texture, format: "r32float" },
    });
    graph.pass({
      id: "fsr2_reactive_mask",
      kind: "compute",
      reads: [{ resource: input, access: "sampled" }],
      writes: [{
        resource: "fsr2_reactive_mask",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    graph.pass({
      id: "fsr2_luminance",
      kind: "compute",
      reads: [{ resource: input, access: "sampled" }],
      writes: [{
        resource: "fsr2_luminance",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    graph.pass({
      id: "fsr2_reconstruct",
      kind: "compute",
      reads: [
        { resource: input, access: "sampled" },
        { resource: "depth", access: "sampled" },
        { resource: "motion_vectors", access: "sampled" },
      ],
      writes: [{
        resource: "fsr2_reconstructed",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    graph.pass({
      id: "fsr2_depth_clip",
      kind: "compute",
      reads: [
        { resource: "depth", access: "sampled" },
        { resource: "motion_vectors", access: "sampled" },
        { resource: "fsr2_depth_history", access: "sampled" },
      ],
      writes: [{
        resource: "fsr2_depth_clip",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["fsr2_reconstruct"],
    });
    graph.pass({
      id: "fsr2_locks",
      kind: "compute",
      reads: [
        { resource: "fsr2_luminance", access: "sampled" },
        { resource: "fsr2_reconstructed", access: "sampled" },
      ],
      writes: [{
        resource: "fsr2_locks",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["fsr2_luminance", "fsr2_reconstruct"],
    });
    graph.pass({
      id: "fsr2_accumulate",
      kind: "compute",
      reads: [
        { resource: input, access: "sampled" },
        { resource: "fsr2_reconstructed", access: "sampled" },
        { resource: "fsr2_depth_clip", access: "sampled" },
        { resource: "fsr2_locks", access: "sampled" },
        { resource: "fsr2_reactive_mask", access: "sampled" },
        { resource: "fsr2_color_history", access: "sampled" },
      ],
      writes: [{
        resource: "fsr2_accumulated",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["fsr2_depth_clip", "fsr2_locks", "fsr2_reactive_mask"],
    });
    graph.pass({
      id: "fsr2_rcas",
      kind: "compute",
      reads: [{ resource: "fsr2_accumulated", access: "sampled" }],
      writes: [{
        resource: "fsr2_output",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: ["fsr2_accumulate"],
    });
    graph.pass({
      id: "fsr2_store_history",
      kind: "compute",
      reads: [
        { resource: "fsr2_accumulated", access: "sampled" },
        { resource: "depth", access: "sampled" },
      ],
      writes: [
        {
          resource: "fsr2_color_history_next",
          access: "storage_write",
          load: "discard",
          store: "store",
        },
        {
          resource: "fsr2_depth_history_next",
          access: "storage_write",
          load: "discard",
          store: "store",
        },
      ],
      after: ["fsr2_rcas"],
    });
    input = "fsr2_output";
    after = "fsr2_store_history";
  }
  if (profile.bloom) {
    graph.resource({
      id: "bloom",
      lifetime: "transient",
      descriptor: {
        type: "texture",
        width: surface.width,
        height: surface.height,
        depth_or_layers: 1,
        mip_levels: 6,
        sample_count: 1,
        format: "rgba16float",
        usage: texture_usage.sampled | texture_usage.storage,
      },
    });
    graph.pass({
      id: "bloom",
      kind: "compute",
      reads: [{ resource: input, access: "sampled" }],
      writes: [{
        resource: "bloom",
        access: "storage_write",
        load: "discard",
        store: "store",
      }],
      after: [after],
    });
    input = "bloom";
    after = "bloom";
  }
  graph.pass({
    id: "tone_map",
    kind: "render",
    reads: [{ resource: input, access: "sampled" }],
    writes: [{
      resource: "surface",
      access: "attachment",
      load: "clear",
      store: "store",
    }],
    after: [after],
  });
}

function color_writes(profile: RenderQualityProfile) {
  const color = profile.sample_count === 1
    ? [{
      resource: "hdr",
      access: "attachment" as const,
      load: "clear" as const,
      store: "store" as const,
    }]
    : [{
      resource: "hdr_msaa",
      access: "attachment" as const,
      load: "clear" as const,
      store: "discard" as const,
      resolve: "hdr",
    }];
  return profile.upscaling.type === "fsr2"
    ? [...color, {
      resource: "motion_vectors",
      access: "attachment" as const,
      load: "clear" as const,
      store: "store" as const,
    }]
    : color;
}

function differences(path: RenderQualityProfile["path"]): readonly string[] {
  if (path === "compatibility") {
    return [
      "bounded direct lights",
      "no clustered light lists",
      "reduced material feature envelope",
    ];
  }
  if (path === "clustered_forward") {
    return [
      "clustered light assignment",
      "sorted alpha transparency",
      "MSAA when requested",
    ];
  }
  return [
    "single-sample G-buffer",
    "deferred opaque lighting",
    "transparent objects use a forward tail pass",
  ];
}
