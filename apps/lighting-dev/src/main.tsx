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
import { LightingLab, type LightingLabSnapshot } from "./lighting_lab.ts";
import { type LightingReference, reference_presentations } from "./scene.ts";
import "./styles.css";

const initial_reference = parse_optional_reference(
  new URL(globalThis.location.href).searchParams.get("scene"),
);
const initial_presentation = reference_presentations[initial_reference];
const starting_snapshot: LightingLabSnapshot = {
  adapter: "Starting WebGPU",
  kind: "loading",
  move_speed: initial_presentation.move_speed,
  reference: initial_reference,
  settings: initial_presentation.settings,
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
    void LightingLab.create(canvas, initial_reference).then((lighting_lab) => {
      created = lighting_lab;
      if (active) set_lab(lighting_lab);
      else lighting_lab.dispose();
    }).catch((error) => {
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
      adapter: "WebGPU unavailable",
      kind: "failed",
      message: startup_error,
      move_speed: snapshot.move_speed,
      reference: snapshot.reference,
      settings: snapshot.settings,
    };

  return (
    <main className="lighting-lab">
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
  const [position, set_position] = useState({ x: 20, y: 20 });
  const style: CSSProperties = {
    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
  };
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
    <aside ref={panel} className="settings-panel" style={style}>
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
        }}
        onPointerMove={move_panel}
        onPointerUp={(event) => {
          if (drag.current?.pointer_id !== event.pointerId) return;
          drag.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <div>
          <span className="window-mark" aria-hidden="true" />
          <h1>Lighting</h1>
        </div>
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
      </header>
      <div className="settings-panel-content">
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
          <ToggleButton value="bistro">Bistro</ToggleButton>
          <ToggleButton value="caldera">Hotel</ToggleButton>
          <ToggleButton value="fog-room">Fog</ToggleButton>
        </ToggleButtonGroup>
        <SettingSlider
          label="Sun"
          value={snapshot.settings.sun_intensity}
          display={snapshot.settings.sun_intensity.toFixed(1)}
          min={0}
          max={8}
          step={0.1}
          disabled={lab === undefined}
          on_change={(value) => lab?.set_setting("sun_intensity", value)}
        />
        <SettingSlider
          label="Exposure"
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
  disabled,
  display,
  label,
  max,
  min,
  on_change,
  step,
  value,
}: SettingSliderProps) {
  return (
    <label className="setting-slider">
      <span>{label}</span>
      <output>{display}</output>
      <Slider
        aria-label={label}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={on_change}
      />
    </label>
  );
}

function StatusLine({ snapshot }: { readonly snapshot: LightingLabSnapshot }) {
  if (snapshot.kind === "failed") {
    return (
      <footer className="status-line" data-state="failed">
        <span className="status-dot" aria-hidden="true" />
        <output title={snapshot.message}>{snapshot.message}</output>
      </footer>
    );
  }
  if (snapshot.kind === "loading") {
    return (
      <footer className="status-line" data-state="loading">
        <span className="status-dot" aria-hidden="true" />
        <output>Loading scene</output>
      </footer>
    );
  }
  return (
    <footer className="status-line" data-state="ready">
      <span className="status-dot" aria-hidden="true" />
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
  if (value === "bistro" || value === "caldera" || value === "fog-room") {
    return value;
  }
  throw new Error(`unknown lighting reference ${JSON.stringify(value)}`);
}

function parse_optional_reference(value: string | null): LightingReference {
  return value === null ? "bistro" : parse_reference(value);
}

const root = document.getElementById("root");
if (root === null) throw new Error('lighting lab index is missing "root"');
createRoot(root).render(<LightingLabApplication />);
