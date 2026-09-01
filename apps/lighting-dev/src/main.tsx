import { Button, Slider, ToggleButton, ToggleButtonGroup } from "@comp0/react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  LightingLab,
  type LightingLabConfiguration,
  type LightingLabSnapshot,
} from "./lighting_lab.ts";
import { type LightingReference, reference_presentations } from "./scene.ts";
import {
  lighting_technique_preferences,
  type LightingTechniqueSelection,
} from "./technique.ts";
import "./styles.css";

const search_parameters = new URL(globalThis.location.href).searchParams;
const initial_reference = parse_optional_reference(
  search_parameters.get("scene"),
);
const render_comparison = parse_render_comparison(
  search_parameters.get("comparison"),
);
const initial_presentation = reference_presentations[initial_reference];
const initial_configuration: LightingLabConfiguration = {
  fog_material_response: render_comparison.fog_material_response,
  initial_reference,
  path_tracing_quality: {
    maximum_bounces: render_comparison.maximum_bounces,
    samples_per_frame: 4,
  },
  reference_normal_response: render_comparison.reference_normal_response,
};
const starting_snapshot: LightingLabSnapshot = {
  adapter: "Starting WebGPU",
  center_pick: "pending",
  center_pick_samples: 0,
  frame: { type: "pending" },
  hdr_output: {
    type: "unavailable",
    reason: "HDR availability is detected after WebGPU starts.",
  },
  kind: "loading",
  move_speed: initial_presentation.move_speed,
  output_mode: "sdr",
  reference: initial_reference,
  renderer_status: { type: "starting" },
  settings: initial_presentation.settings,
  technique: lighting_technique_preferences(
    initial_presentation.technique_support,
    "raster",
    initial_configuration.path_tracing_quality,
  ),
  validation_error_count: 0,
};
const subscribe_to_nothing = (): () => void => () => undefined;
const starting_snapshot_reader = (): LightingLabSnapshot => starting_snapshot;

function LightingLabApplication() {
  const [canvas, set_canvas] = useState<HTMLCanvasElement | null>(null);
  const [lab, set_lab] = useState<LightingLab | undefined>();
  const [startup_error, set_startup_error] = useState<string | undefined>();
  useEffect(() => {
    if (canvas === null) return;
    let active = true;
    let created: LightingLab | undefined;
    void LightingLab.create(canvas, initial_configuration).then(
      (lighting_lab) => {
        created = lighting_lab;
        if (active) set_lab(lighting_lab);
        else lighting_lab.dispose();
      },
    ).catch((error) => {
      if (active) {
        set_startup_error(
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return () => {
      active = false;
      created?.dispose();
    };
  }, [canvas]);
  const snapshot = useSyncExternalStore(
    lab?.subscribe ?? subscribe_to_nothing,
    lab?.snapshot ?? starting_snapshot_reader,
    lab?.snapshot ?? starting_snapshot_reader,
  );
  const shown_snapshot: LightingLabSnapshot = startup_error === undefined
    ? snapshot
    : {
      ...snapshot,
      adapter: "WebGPU unavailable",
      kind: "failed",
      message: startup_error,
    };

  return (
    <main
      className="lighting-lab"
      data-accumulated-samples={accumulated_samples(shown_snapshot)}
      data-adapter={shown_snapshot.adapter}
      data-center-pick={shown_snapshot.center_pick}
      data-center-pick-samples={shown_snapshot.center_pick_samples}
      data-frame-reason={frame_reason(shown_snapshot)}
      data-frame-technique={shown_snapshot.frame.type}
      data-output-mode={shown_snapshot.output_mode}
      data-reference={shown_snapshot.reference}
      data-render-comparison={render_comparison.type}
      data-renderer-status={shown_snapshot.renderer_status.type}
      data-runtime-state={shown_snapshot.kind}
      data-technique-support={shown_snapshot.technique.support.type}
      data-validation-errors={shown_snapshot.validation_error_count}
    >
      <canvas
        ref={set_canvas}
        aria-label="Interactive 3D lighting test scene"
        onClick={() => {
          if (lab === undefined) return;
          void lab.capture_pointer().catch((error) => {
            set_startup_error(
              error instanceof Error ? error.message : String(error),
            );
          });
        }}
      />
      <SettingsPanel lab={lab} snapshot={shown_snapshot} />
    </main>
  );
}

interface SettingsPanelProps {
  readonly lab: LightingLab | undefined;
  readonly snapshot: LightingLabSnapshot;
}

function SettingsPanel({ lab, snapshot }: SettingsPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<
    {
      readonly pointer_id: number;
      readonly offset_x: number;
      readonly offset_y: number;
    } | undefined
  >(undefined);
  const [panel_dragging, set_panel_dragging] = useState(false);
  const [position, set_position] = useState({ x: 20, y: 20 });
  const style: CSSProperties = {
    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
  };
  const path_tracing_unavailable = snapshot.technique.support.type ===
      "raster_only"
    ? snapshot.technique.support.reason
    : undefined;
  const move_panel = (event: ReactPointerEvent<HTMLElement>): void => {
    const active_drag = drag.current;
    if (
      active_drag === undefined || active_drag.pointer_id !== event.pointerId ||
      panel.current === null
    ) return;
    set_position({
      x: Math.max(
        8,
        Math.min(
          globalThis.innerWidth - panel.current.offsetWidth - 8,
          event.clientX - active_drag.offset_x,
        ),
      ),
      y: Math.max(
        8,
        Math.min(
          globalThis.innerHeight - panel.current.offsetHeight - 8,
          event.clientY - active_drag.offset_y,
        ),
      ),
    });
  };
  return (
    <aside
      ref={panel}
      className="settings-panel"
      data-dragging={panel_dragging || undefined}
      style={style}
    >
      <header
        className="settings-panel-titlebar"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointer_id: event.pointerId,
            offset_x: event.clientX - position.x,
            offset_y: event.clientY - position.y,
          };
          set_panel_dragging(true);
        }}
        onPointerMove={move_panel}
        onPointerUp={(event) => {
          if (drag.current?.pointer_id !== event.pointerId) return;
          drag.current = undefined;
          set_panel_dragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointer_id !== event.pointerId) return;
          drag.current = undefined;
          set_panel_dragging(false);
        }}
      >
        <h1>Lighting</h1>
        <div className="titlebar-actions">
          <Button
            type="button"
            className="hdr-output"
            aria-pressed={snapshot.output_mode === "hdr"}
            disabled={lab === undefined ||
              snapshot.hdr_output.type === "unavailable"}
            title={snapshot.hdr_output.type === "unavailable"
              ? snapshot.hdr_output.reason
              : "Use extended-range HDR display output"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              lab?.set_output_mode(
                snapshot.output_mode === "hdr" ? "sdr" : "hdr",
              );
            }}
          >
            HDR
          </Button>
          <Button
            type="button"
            className="reset-camera"
            disabled={lab === undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              lab?.reset_camera();
            }}
          >
            Reset view
          </Button>
        </div>
      </header>
      <div className="settings-panel-content">
        <div
          className="scene-picker-shell"
          data-reference={snapshot.reference}
        >
          <span className="scene-picker-selection" aria-hidden="true" />
          <ToggleButtonGroup
            type="single"
            className="scene-picker"
            aria-label="Reference scene"
            value={snapshot.reference}
            onChange={(value) => {
              if (value === "") return;
              void lab?.select_reference(parse_reference(value));
            }}
          >
            <ToggleButton value="cornell">Cornell</ToggleButton>
            <ToggleButton value="bistro">Bistro</ToggleButton>
            <ToggleButton value="caldera">Hotel</ToggleButton>
            <ToggleButton value="fog-room">Fog</ToggleButton>
          </ToggleButtonGroup>
        </div>
        <ToggleButtonGroup
          type="single"
          className="technique-picker"
          aria-label="Render technique"
          value={snapshot.technique.selection}
          onChange={(value) => {
            if (value === "") return;
            lab?.select_technique(parse_technique(value));
          }}
        >
          <ToggleButton value="raster">Raster</ToggleButton>
          <ToggleButton
            value="path_traced"
            aria-describedby={path_tracing_unavailable === undefined
              ? undefined
              : "path-tracing-availability"}
            disabled={lab === undefined ||
              path_tracing_unavailable !== undefined}
            title={path_tracing_unavailable}
          >
            Path traced
          </ToggleButton>
        </ToggleButtonGroup>
        {path_tracing_unavailable === undefined ? null : (
          <p
            id="path-tracing-availability"
            className="technique-availability"
          >
            {path_tracing_unavailable}
          </p>
        )}
        <SettingSlider
          label="Samples / frame"
          accent="#e9a8ff"
          value={snapshot.technique.path_samples_per_frame}
          display={String(snapshot.technique.path_samples_per_frame)}
          min={1}
          max={16}
          step={1}
          disabled={lab === undefined ||
            snapshot.technique.selection === "raster"}
          on_change={(value) => lab?.set_path_samples(value)}
        />
        <SettingSlider
          label="Sun"
          accent="#f5c451"
          value={snapshot.settings.sun_intensity}
          display={snapshot.settings.sun_intensity.toFixed(1)}
          min={0}
          max={8}
          step={0.1}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_setting("sun_intensity", value)}
        />
        <SettingSlider
          label="Ambient"
          accent="#75d5dd"
          value={snapshot.settings.ambient_intensity}
          display={snapshot.settings.ambient_intensity.toFixed(2)}
          min={0}
          max={2}
          step={0.05}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_setting("ambient_intensity", value)}
        />
        <SettingSlider
          label="Exposure"
          accent="#8aa9ff"
          value={snapshot.settings.exposure}
          display={snapshot.settings.exposure.toFixed(2)}
          min={-3}
          max={2}
          step={0.05}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_setting("exposure", value)}
        />
        <SettingSlider
          label="Fog"
          accent="#b892ff"
          value={snapshot.settings.fog_density}
          display={snapshot.settings.fog_density.toFixed(3)}
          min={0}
          max={0.05}
          step={0.0005}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_setting("fog_density", value)}
        />
        <SettingSlider
          label="Move speed"
          accent="#77d995"
          value={snapshot.move_speed}
          display={`${snapshot.move_speed.toFixed(1)} m/s`}
          min={0.5}
          max={60}
          step={0.5}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_move_speed(value)}
        />
      </div>
      <StatusLine snapshot={snapshot} />
    </aside>
  );
}

interface SettingSliderProps {
  readonly accent: string;
  readonly disabled: boolean;
  readonly display: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly on_change: (value: number) => void;
  readonly step: number;
  readonly value: number;
}

function SettingSlider({
  accent,
  disabled,
  display,
  label,
  max,
  min,
  on_change,
  step,
  value,
}: SettingSliderProps) {
  const progress = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const fill_width = `calc(${progress * 100}% + ${(1 - progress) * 44}px)`;
  return (
    <label className="setting-slider">
      <span className="setting-slider-heading">
        <span>{label}</span>
        <output>{display}</output>
      </span>
      <span className="setting-slider-control">
        <span
          className="setting-slider-fill"
          style={{ backgroundColor: accent, width: fill_width }}
          aria-hidden="true"
        />
        <span className="setting-slider-ticks" aria-hidden="true">
          {[0, 25, 50, 75, 100].map((position) => (
            <span key={position} style={{ left: `${position}%` }} />
          ))}
        </span>
        <span className="setting-slider-thumb-path" aria-hidden="true">
          <span
            className="setting-slider-thumb"
            style={{ borderColor: accent, left: `${progress * 100}%` }}
          >
            <svg viewBox="0 0 16 16">
              <path d="M5 4.5v7M8 3v10M11 4.5v7" />
            </svg>
          </span>
        </span>
        <Slider
          aria-label={label}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={on_change}
        />
      </span>
    </label>
  );
}

function StatusLine({ snapshot }: { readonly snapshot: LightingLabSnapshot }) {
  if (snapshot.kind === "failed") {
    return (
      <footer className="status-line" data-state="failed">
        <output title={snapshot.message}>{snapshot.message}</output>
      </footer>
    );
  }
  if (snapshot.kind === "loading") {
    return (
      <footer className="status-line" data-state="loading">
        <output>Loading scene in background</output>
      </footer>
    );
  }
  if (
    snapshot.renderer_status.type !== "ready" &&
    snapshot.renderer_status.type !== "starting"
  ) {
    return (
      <footer className="status-line" data-state="failed">
        <output title={snapshot.renderer_status.reason}>
          {snapshot.renderer_status.reason}
        </output>
      </footer>
    );
  }
  if (snapshot.source_materials === "upstream-omitted") {
    return (
      <footer className="status-line" data-state="ready">
        <output title="Activision's source release excludes the hotel textures and materials.">
          Hotel source is geometry-only · upstream textures omitted
        </output>
      </footer>
    );
  }
  if (snapshot.frame.type === "path_traced") {
    return (
      <footer className="status-line" data-state="ready">
        <output>
          Path traced · {snapshot.frame.accumulated_samples.toLocaleString()}
          {" samples"}
        </output>
      </footer>
    );
  }
  if (
    snapshot.frame.type === "raster" &&
    snapshot.frame.reason === "camera_motion"
  ) {
    return (
      <footer className="status-line" data-state="ready">
        <output>Raster preview · path trace resumes when movement stops</output>
      </footer>
    );
  }
  return (
    <footer className="status-line" data-state="ready">
      <output>
        {snapshot.pointer_locked
          ? "WASD · mouse · scroll · Esc"
          : `${snapshot.surface_count.toLocaleString()} surfaces · ${
            Math.round(snapshot.load_milliseconds).toLocaleString()
          } ms · click scene`}
      </output>
    </footer>
  );
}

function parse_reference(value: string): LightingReference {
  if (
    value === "cornell" || value === "bistro" || value === "caldera" ||
    value === "fog-room"
  ) {
    return value;
  }
  throw new Error(`unknown lighting reference ${JSON.stringify(value)}`);
}

function parse_optional_reference(value: string | null): LightingReference {
  return value === null ? "cornell" : parse_reference(value);
}

function parse_technique(value: string): LightingTechniqueSelection {
  if (value === "raster" || value === "path_traced") return value;
  throw new Error(`unknown lighting technique ${JSON.stringify(value)}`);
}

type LightingRenderComparison =
  | {
    readonly fog_material_response: "authored";
    readonly maximum_bounces: 6;
    readonly reference_normal_response: "authored";
    readonly type: "reference";
  }
  | {
    readonly fog_material_response: "authored";
    readonly maximum_bounces: 1;
    readonly reference_normal_response: "authored";
    readonly type: "single_bounce";
  }
  | {
    readonly fog_material_response: "diffuse_control";
    readonly maximum_bounces: 6;
    readonly reference_normal_response: "authored";
    readonly type: "diffuse_materials";
  }
  | {
    readonly fog_material_response: "authored";
    readonly maximum_bounces: 6;
    readonly reference_normal_response: "flat_control";
    readonly type: "flat_normals";
  };

function parse_render_comparison(
  value: string | null,
): LightingRenderComparison {
  if (value === null) {
    return {
      fog_material_response: "authored",
      maximum_bounces: 6,
      reference_normal_response: "authored",
      type: "reference",
    };
  }
  if (value === "single-bounce") {
    return {
      fog_material_response: "authored",
      maximum_bounces: 1,
      reference_normal_response: "authored",
      type: "single_bounce",
    };
  }
  if (value === "diffuse-materials") {
    return {
      fog_material_response: "diffuse_control",
      maximum_bounces: 6,
      reference_normal_response: "authored",
      type: "diffuse_materials",
    };
  }
  if (value === "flat-normals") {
    return {
      fog_material_response: "authored",
      maximum_bounces: 6,
      reference_normal_response: "flat_control",
      type: "flat_normals",
    };
  }
  throw new Error(
    `unknown lighting render comparison ${JSON.stringify(value)}`,
  );
}

function accumulated_samples(snapshot: LightingLabSnapshot): number {
  return snapshot.frame.type === "path_traced"
    ? snapshot.frame.accumulated_samples
    : 0;
}

function frame_reason(snapshot: LightingLabSnapshot): string {
  if (snapshot.frame.type === "pending") return "pending";
  return snapshot.frame.type === "raster"
    ? snapshot.frame.reason
    : snapshot.frame.accumulation;
}

const root = document.getElementById("root");
if (root === null) throw new Error('lighting lab index is missing "root"');
createRoot(root).render(<LightingLabApplication />);
