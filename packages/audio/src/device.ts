import type { Observer } from "@ink/observability/observer.ts";
import type { AudioGraphSnapshot } from "./graph.ts";
import type { AudioPlan, AudioPlanCommand } from "./mixer.ts";
import type {
  AudioClip,
  AudioDeviceState,
  BusId,
  ClipId,
  StreamId,
  VoiceId,
} from "./model.ts";

export interface AudioStreamPlayback {
  start(options: {
    readonly context: AudioContext;
    readonly output: AudioNode;
    readonly audio_time: number;
    readonly offset_seconds: number;
    readonly pitch: number;
  }): { readonly stop: () => void };
}

export type AudioStreamFactory = (
  stream: StreamId,
) => AudioStreamPlayback | undefined;

export interface AudioOutput {
  readonly current_time_seconds: number;
  install_clip(clip: AudioClip): void;
  install_graph(graph: AudioGraphSnapshot): void;
  apply(plan: AudioPlan): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export interface AudioDeviceOptions {
  readonly output?: AudioOutput;
  readonly maximum_retained_commands: number;
  readonly observer?: Observer;
}

export class AudioDevice {
  readonly #output: AudioOutput | undefined;
  readonly #maximum_retained_commands: number;
  readonly #observer: Observer | undefined;
  #state: AudioDeviceState;
  #retained: AudioPlanCommand[] = [];

  constructor(options: AudioDeviceOptions) {
    if (
      !Number.isSafeInteger(options.maximum_retained_commands) ||
      options.maximum_retained_commands < 0
    ) {
      throw new Error(
        `audio retained command maximum ${
          JSON.stringify(options.maximum_retained_commands)
        } must be nonnegative`,
      );
    }
    this.#output = options.output;
    this.#maximum_retained_commands = options.maximum_retained_commands;
    this.#observer = options.observer;
    this.#state = options.output === undefined
      ? {
        type: "unavailable",
        reason: "audio output capability is unavailable",
      }
      : { type: "blocked", reason: "audio output requires user activation" };
  }

  get state(): AudioDeviceState {
    return { ...this.#state };
  }

  get current_time_seconds(): number | undefined {
    return this.#output?.current_time_seconds;
  }

  get retained_commands(): readonly AudioPlanCommand[] {
    return this.#retained.map(snapshot_plan_command);
  }

  install_clip(clip: AudioClip): void {
    if (this.#output === undefined) return;
    this.#perform(
      "install clip",
      clip.id,
      () => this.#output!.install_clip(clip),
    );
  }

  install_graph(graph: AudioGraphSnapshot): void {
    if (this.#output === undefined) return;
    this.#perform(
      "install graph",
      `revision ${graph.revision}`,
      () => this.#output!.install_graph(graph),
    );
  }

  submit(plan: AudioPlan): void {
    if (this.#state.type !== "running" || this.#output === undefined) {
      this.#retain(plan.commands);
      this.#observer?.event("audio.plan.retained", {
        command_count: plan.commands.length,
        device_state: this.#state.type,
        retained_count: this.#retained.length,
      });
      return;
    }
    this.#perform(
      "apply plan",
      `${plan.commands.length} commands`,
      () => this.#output!.apply(plan),
    );
  }

  async activate(): Promise<AudioDeviceState> {
    if (this.#output === undefined) return this.#state;
    try {
      await this.#output.resume();
      this.#state = { type: "running" };
      const retained = this.#retained;
      if (retained.length > 0) {
        this.#output.apply({
          commands: Object.freeze([...retained]),
          stolen: Object.freeze([]),
          dropped_sequences: Object.freeze([]),
        });
      }
      this.#retained = [];
      this.#observer?.event("audio.device.running", {
        replayed_commands: retained.length,
      });
    } catch (error) {
      this.#state = {
        type: "blocked",
        reason: evidence(error, "audio output activation failed"),
      };
      this.#observer?.diagnostic(
        "warning",
        "audio.activate",
        this.#state.reason,
        {},
      );
    }
    return this.#state;
  }

  async suspend(): Promise<AudioDeviceState> {
    if (this.#output === undefined) return this.#state;
    try {
      await this.#output.suspend();
      this.#state = { type: "suspended" };
      this.#observer?.event("audio.device.suspended");
    } catch (error) {
      this.interrupt(evidence(error, "audio output suspension failed"));
    }
    return this.#state;
  }

  interrupt(reason: string): void {
    const parsed = reason.trim();
    if (parsed.length === 0) {
      throw new Error(
        `audio interruption reason ${JSON.stringify(reason)} cannot be empty`,
      );
    }
    this.#state = { type: "interrupted", reason: parsed };
    this.#observer?.diagnostic("warning", "audio.interrupt", parsed, {});
  }

  async recover(attempt: number): Promise<AudioDeviceState> {
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error(
        `audio recovery attempt ${JSON.stringify(attempt)} must be positive`,
      );
    }
    if (this.#output === undefined) return this.#state;
    this.#state = { type: "recovering", attempt };
    return await this.activate();
  }

  async close(): Promise<void> {
    if (this.#output === undefined) return;
    try {
      await this.#output.close();
      this.#state = { type: "unavailable", reason: "audio output was closed" };
      this.#retained = [];
    } catch (error) {
      const reason = evidence(error, "audio output close failed");
      this.#state = { type: "interrupted", reason };
      throw new Error(reason, { cause: error });
    }
  }

  #retain(commands: readonly AudioPlanCommand[]): void {
    if (this.#maximum_retained_commands === 0) return;
    this.#retained = [
      ...this.#retained,
      ...commands.map(snapshot_plan_command),
    ].slice(
      -this.#maximum_retained_commands,
    );
  }

  #perform(operation: string, identity: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      const reason = evidence(
        error,
        `audio ${operation} for ${identity} failed`,
      );
      this.#state = { type: "interrupted", reason };
      this.#observer?.diagnostic(
        "error",
        `audio.${operation.replaceAll(" ", "_")}`,
        reason,
        { identity },
      );
      throw new Error(reason, { cause: error });
    }
  }
}

function snapshot_plan_command(command: AudioPlanCommand): AudioPlanCommand {
  if (command.type !== "start") return Object.freeze({ ...command });
  const voice = command.voice;
  return Object.freeze({
    ...command,
    voice: Object.freeze({
      ...voice,
      source: Object.freeze({ ...voice.source }),
      ...(voice.loop === undefined
        ? {}
        : { loop: Object.freeze({ ...voice.loop }) }),
      ...(voice.spatial === undefined
        ? {}
        : { spatial: Object.freeze({ ...voice.spatial }) }),
    }),
  });
}

interface NativeBus {
  readonly input: GainNode;
  readonly output: AudioNode;
  readonly nodes: AudioNode[];
}

interface NativeVoice {
  readonly source: AudioScheduledSourceNode | undefined;
  readonly gain: GainNode | undefined;
  readonly bus: BusId;
  readonly nodes: readonly AudioNode[];
  readonly authored_gain: number;
  readonly stream_stop?: () => void;
}

interface NativeEffect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly nodes: readonly AudioNode[];
}

export class WebAudioOutput implements AudioOutput {
  readonly #context: AudioContext;
  readonly #stream_factory: AudioStreamFactory | undefined;
  readonly #clips = new Map<ClipId, AudioBuffer>();
  #buses = new Map<BusId, NativeBus>();
  #voices = new Map<VoiceId, NativeVoice>();

  constructor(context: AudioContext, stream_factory?: AudioStreamFactory) {
    this.#context = context;
    this.#stream_factory = stream_factory;
  }

  get current_time_seconds(): number {
    return this.#context.currentTime;
  }

  install_clip(clip: AudioClip): void {
    const buffer = this.#context.createBuffer(
      clip.decoded.channels.length,
      clip.decoded.frame_count,
      clip.decoded.sample_rate,
    );
    for (const [index, channel] of clip.decoded.channels.entries()) {
      buffer.copyToChannel(new Float32Array(channel), index);
    }
    this.#clips.set(clip.id, buffer);
  }

  install_graph(graph: AudioGraphSnapshot): void {
    for (const voice of this.#voices.values()) {
      if (!graph.buses.some((bus) => bus.id === voice.bus)) {
        throw new Error(
          `audio graph revision ${graph.revision} removes active voice bus ${
            JSON.stringify(voice.bus)
          }`,
        );
      }
    }
    const next = new Map<BusId, NativeBus>();
    try {
      for (const bus of graph.buses) {
        const input = this.#context.createGain();
        input.gain.value = bus.gain;
        const nodes: AudioNode[] = [input];
        let output: AudioNode = input;
        for (const effect of bus.effects) {
          const rack = this.#create_effect(effect);
          output.connect(rack.input);
          nodes.push(...rack.nodes);
          output = rack.output;
        }
        next.set(bus.id, { input, output, nodes });
      }
      for (const bus of graph.buses) {
        const native = next.get(bus.id)!;
        if (bus.output === undefined) {
          native.output.connect(this.#context.destination);
        } else native.output.connect(next.get(bus.output)!.input);
        for (const send of bus.sends) {
          const gain = this.#context.createGain();
          gain.gain.value = send.gain;
          native.output.connect(gain);
          gain.connect(next.get(send.bus)!.input);
          native.nodes.push(gain);
        }
      }
    } catch (error) {
      disconnect_buses(next);
      throw error;
    }
    const rerouted: NativeVoice[] = [];
    try {
      for (const voice of this.#voices.values()) {
        voice.gain?.connect(next.get(voice.bus)!.input);
        rerouted.push(voice);
      }
    } catch (error) {
      for (const voice of rerouted) {
        voice.gain?.disconnect(next.get(voice.bus)!.input);
      }
      disconnect_buses(next);
      throw error;
    }
    for (const voice of this.#voices.values()) {
      const previous = this.#buses.get(voice.bus);
      if (previous !== undefined) voice.gain?.disconnect(previous.input);
    }
    disconnect_buses(this.#buses);
    this.#buses = next;
  }

  apply(plan: AudioPlan): void {
    for (const command of plan.commands) {
      if (command.type === "start") this.#start(command);
      else if (command.type === "stop") {
        this.#stop(command.voice, command.audio_time, command.fade_seconds);
      } else if (command.type === "bus_gain") {
        const bus = this.#buses.get(command.bus);
        if (bus === undefined) {
          throw new Error(
            `audio bus ${JSON.stringify(command.bus)} is not installed`,
          );
        }
        bus.input.gain.setValueAtTime(bus.input.gain.value, command.audio_time);
        bus.input.gain.linearRampToValueAtTime(
          command.gain,
          command.audio_time + command.fade_seconds,
        );
      } else {
        this.#set_pause(command.voice, command.type);
      }
    }
  }

  async resume(): Promise<void> {
    await this.#context.resume();
  }

  async suspend(): Promise<void> {
    await this.#context.suspend();
  }

  async close(): Promise<void> {
    for (const id of [...this.#voices.keys()]) {
      this.#stop(id, this.#context.currentTime, 0);
    }
    disconnect_buses(this.#buses);
    this.#buses.clear();
    this.#clips.clear();
    await this.#context.close();
  }

  #start(command: Extract<AudioPlanCommand, { readonly type: "start" }>): void {
    const bus = this.#buses.get(command.voice.bus);
    if (bus === undefined) {
      throw new Error(
        `audio voice ${command.voice.id} bus ${
          JSON.stringify(command.voice.bus)
        } is not installed`,
      );
    }
    const gain = this.#context.createGain();
    const spatial_gain = command.voice.spatial?.gain ?? 1;
    const authored_gain = command.voice.gain * spatial_gain;
    gain.gain.setValueAtTime(
      command.fade_seconds === 0 ? authored_gain : 0,
      command.voice.started_audio_time,
    );
    if (command.fade_seconds > 0) {
      gain.gain.linearRampToValueAtTime(
        authored_gain,
        command.voice.started_audio_time + command.fade_seconds,
      );
    }
    gain.connect(bus.input);
    const panner = command.voice.spatial === undefined
      ? undefined
      : this.#context.createStereoPanner();
    if (panner !== undefined) {
      panner.pan.value = command.voice.spatial!.pan;
      panner.connect(gain);
    }
    const source_output: AudioNode = panner ?? gain;
    const pitch = command.voice.pitch *
      (command.voice.spatial?.doppler_pitch ?? 1);
    if (command.voice.source.type === "clip") {
      const buffer = this.#clips.get(command.voice.source.id);
      if (buffer === undefined) {
        throw new Error(
          `audio voice ${command.voice.id} clip ${
            JSON.stringify(command.voice.source.id)
          } is not installed`,
        );
      }
      const source = this.#context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = pitch;
      if (command.voice.loop !== undefined) {
        source.loop = true;
        source.loopStart = command.voice.loop.start_seconds;
        source.loopEnd = command.voice.loop.end_seconds;
      }
      source.connect(source_output);
      source.addEventListener(
        "ended",
        () => this.#release_voice(command.voice.id),
        { once: true },
      );
      source.start(
        command.voice.started_audio_time,
        command.voice.source_offset_seconds,
      );
      this.#voices.set(command.voice.id, {
        source,
        gain,
        bus: command.voice.bus,
        nodes: panner === undefined ? [gain] : [panner, gain],
        authored_gain,
      });
      return;
    }
    const playback = this.#stream_factory?.(command.voice.source.id);
    if (playback === undefined) {
      source_output.disconnect();
      gain.disconnect();
      throw new Error(
        `audio voice ${command.voice.id} stream ${
          JSON.stringify(command.voice.source.id)
        } has no playback source`,
      );
    }
    const started = playback.start({
      context: this.#context,
      output: source_output,
      audio_time: command.voice.started_audio_time,
      offset_seconds: command.voice.source_offset_seconds,
      pitch,
    });
    this.#voices.set(command.voice.id, {
      source: undefined,
      gain,
      bus: command.voice.bus,
      nodes: panner === undefined ? [gain] : [panner, gain],
      authored_gain,
      stream_stop: started.stop,
    });
  }

  #stop(voice: VoiceId, audio_time: number, fade_seconds: number): void {
    const native = this.#voices.get(voice);
    if (native === undefined) return;
    if (native.gain !== undefined && fade_seconds > 0) {
      native.gain.gain.setValueAtTime(native.gain.gain.value, audio_time);
      native.gain.gain.linearRampToValueAtTime(0, audio_time + fade_seconds);
    }
    native.source?.stop(audio_time + fade_seconds);
    if (native.source === undefined) {
      native.stream_stop?.();
      this.#release_voice(voice);
    }
  }

  #set_pause(voice: VoiceId | undefined, operation: "pause" | "resume"): void {
    if (voice !== undefined) {
      const native = this.#voices.get(voice);
      if (native?.gain !== undefined) {
        native.gain.gain.value = operation === "pause"
          ? 0
          : native.authored_gain;
      }
      return;
    }
    for (const native of this.#voices.values()) {
      if (native.gain !== undefined) {
        native.gain.gain.value = operation === "pause"
          ? 0
          : native.authored_gain;
      }
    }
  }

  #release_voice(voice: VoiceId): void {
    const native = this.#voices.get(voice);
    if (native === undefined) return;
    native.source?.disconnect();
    for (const node of native.nodes) node.disconnect();
    this.#voices.delete(voice);
  }

  #create_effect(
    effect: AudioGraphSnapshot["buses"][number]["effects"][number],
  ): NativeEffect {
    if (effect.type === "gain") {
      const gain = this.#context.createGain();
      gain.gain.value = effect.gain;
      return { input: gain, output: gain, nodes: [gain] };
    }
    if (effect.type === "filter") {
      const filter = this.#context.createBiquadFilter();
      filter.type = effect.filter;
      filter.frequency.value = effect.frequency_hz;
      filter.Q.value = effect.quality;
      filter.gain.value = effect.gain_db;
      return { input: filter, output: filter, nodes: [filter] };
    }
    if (effect.type === "delay") {
      const delay = this.#context.createDelay(Math.max(1, effect.seconds));
      const feedback = this.#context.createGain();
      delay.delayTime.value = effect.seconds;
      feedback.gain.value = effect.feedback;
      delay.connect(feedback);
      feedback.connect(delay);
      return { input: delay, output: delay, nodes: [delay, feedback] };
    }
    if (effect.type === "convolution") {
      const convolution = this.#context.createConvolver();
      const impulse = this.#clips.get(effect.impulse_clip as ClipId);
      if (impulse === undefined) {
        throw new Error(
          `audio convolution effect ${effect.id} clip ${
            JSON.stringify(effect.impulse_clip)
          } is not installed`,
        );
      }
      convolution.buffer = impulse;
      const input = this.#context.createGain();
      const dry = this.#context.createGain();
      const wet = this.#context.createGain();
      const output = this.#context.createGain();
      dry.gain.value = 1 - effect.wet;
      wet.gain.value = effect.wet;
      input.connect(dry);
      dry.connect(output);
      input.connect(convolution);
      convolution.connect(wet);
      wet.connect(output);
      return {
        input,
        output,
        nodes: [input, dry, convolution, wet, output],
      };
    }
    const compressor = this.#context.createDynamicsCompressor();
    compressor.threshold.value = effect.threshold_db;
    compressor.knee.value = effect.knee_db;
    compressor.ratio.value = effect.ratio;
    compressor.attack.value = effect.attack_seconds;
    compressor.release.value = effect.release_seconds;
    return { input: compressor, output: compressor, nodes: [compressor] };
  }
}

export function create_web_audio_output(
  stream_factory?: AudioStreamFactory,
): AudioOutput | undefined {
  if (typeof AudioContext !== "function") return undefined;
  return new WebAudioOutput(new AudioContext(), stream_factory);
}

function disconnect_buses(buses: ReadonlyMap<BusId, NativeBus>): void {
  for (const bus of buses.values()) {
    for (const node of bus.nodes) node.disconnect();
  }
}

function evidence(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length === 0 ? fallback : `${fallback}: ${message}`;
}
