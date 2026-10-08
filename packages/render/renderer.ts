/** Renderer: owns the device, pipelines and asset store; creates views. */
import { Assets } from "./assets.ts";
import type { Core } from "./core.ts";
import { createPipelines } from "./pipelines.ts";
import { createPostPipelines } from "./post/pipelines.ts";
import { createDummies } from "./resources.ts";
import type { AssetStore, Quality, Renderer, View } from "./types.ts";
import { ViewImpl } from "./view.ts";

export interface RendererOptions {
  /** Reuse an existing device instead of requesting one. */
  device?: GPUDevice;
  /** Prefer the dedicated GPU for game/editor rendering; callers can opt into low power. */
  powerPreference?: GPUPowerPreference;
  /** Base URL asset paths resolve against. Default "/assets/". */
  assetBase?: string;
  /** Quality of views that do not say otherwise (`Overlays.quality`).
   * Default: "low" on software rasterizers (SwiftShader, llvmpipe), else
   * "high". */
  quality?: Quality;
}

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|software|softpipe/i;

/** Whether the adapter behind a device is a CPU rasterizer. */
function isSoftware(
  device: GPUDevice,
  adapter?: GPUAdapter | null,
): boolean {
  const withInfo = device as GPUDevice & { adapterInfo?: GPUAdapterInfo };
  const info = withInfo.adapterInfo ??
    (adapter as (GPUAdapter & { info?: GPUAdapterInfo }) | null | undefined)
      ?.info;
  if (!info) return false;
  const fallback = (info as GPUAdapterInfo & { isFallbackAdapter?: boolean })
    .isFallbackAdapter;
  return !!fallback ||
    SOFTWARE.test(
      `${info.vendor} ${info.architecture} ${info.device} ${info.description}`,
    );
}

export async function createRenderer(
  options: RendererOptions = {},
): Promise<Renderer> {
  let device = options.device;
  let adapter: GPUAdapter | null | undefined;
  let owned = false;
  if (!device) {
    const gpu = (globalThis.navigator as Navigator & { gpu?: GPU } | undefined)
      ?.gpu;
    if (!gpu) throw new Error("WebGPU is not available in this environment");
    adapter = await gpu.requestAdapter({
      powerPreference: options.powerPreference ?? "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter found");
    device = await adapter.requestDevice({ label: "ink" });
    owned = true;
  }
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
  const format = gpu?.getPreferredCanvasFormat() ?? "rgba8unorm";
  const pipelines = createPipelines(device, format);
  const assets = new Assets(device, pipelines, options.assetBase ?? "/assets/");
  const dummies = createDummies(device);
  const core: Core = {
    device,
    format,
    pipelines,
    post: createPostPipelines(device),
    assets,
    dummies,
    quality: options.quality ?? (isSoftware(device, adapter) ? "low" : "high"),
    lost: false,
    frame: 0,
  };
  const views = new Set<ViewImpl>();
  const lost = device.lost.then((info) => {
    core.lost = true;
    return info;
  });
  return {
    device,
    format,
    assets: assets as AssetStore,
    lost,
    createView(target): View {
      const view = new ViewImpl(core, target);
      views.add(view);
      const dispose = view.dispose.bind(view);
      view.dispose = () => {
        views.delete(view);
        dispose();
      };
      return view;
    },
    dispose() {
      for (const view of [...views]) view.dispose();
      assets.dispose();
      dummies.destroy();
      if (owned) device.destroy();
    },
  };
}
