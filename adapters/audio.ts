/** Receives the plain scalar result of ink/audio or an application mix. */
export interface Mix {
  gain: number;
  pan: number;
  rate: number;
  cutoff: number;
}
export interface Voice {
  update(mix: Mix, duration?: number, time?: number): void;
  stop(duration?: number, time?: number): void;
  dispose(): void;
}
function validate(mix: Mix) {
  if (
    !Object.values(mix).every(Number.isFinite) || mix.gain < 0 ||
    Math.abs(mix.pan) > 1 || mix.rate <= 0 || mix.cutoff <= 0
  ) throw new RangeError("Invalid audio mix");
}
function automation(
  context: BaseAudioContext,
  param: AudioParam,
  initial: number,
  at: number,
) {
  const segments = [{ at, end: at, from: initial, to: initial }];
  param.setValueAtTime(initial, at);
  return (value: number, time: number, duration: number) => {
    let held = initial;
    for (const segment of segments) {
      if (time < segment.at) break;
      held = segment.to;
      if (time < segment.end) {
        held = segment.from +
          (segment.to - segment.from) * (time - segment.at) /
            (segment.end - segment.at);
      }
    }
    // Anchor explicitly: a new future ramp must not slope backwards from the
    // previous ramp's end through what should have been a constant interval.
    param.cancelAndHoldAtTime(time);
    param.setValueAtTime(held, time);
    param.linearRampToValueAtTime(value, time + duration);
    const firstFuture = segments.findIndex((segment) => segment.at >= time);
    if (firstFuture >= 0) segments.splice(firstFuture);
    segments.push({ at: time, end: time + duration, from: held, to: value });
    // Retain the current segment and future events, not an update history.
    let current = 0;
    for (let index = 0; index < segments.length; index++) {
      if (segments[index].at <= context.currentTime) current = index;
    }
    if (current > 0) segments.splice(0, current);
  };
}

/** Caller creates/resumes/closes the context and owns the update schedule. */
export function play(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  mix: Mix,
  options: {
    destination?: AudioNode;
    at?: number;
    fade?: number;
    loop?: boolean;
    offset?: number;
  } = {},
): Voice {
  validate(mix);
  const at = options.at ?? context.currentTime;
  const fade = options.fade ?? 0;
  const offset = options.offset ?? 0;
  if (
    ![at, fade, offset].every(Number.isFinite) || at < context.currentTime ||
    fade < 0 || offset < 0 || offset > buffer.duration
  ) throw new RangeError("Invalid playback timing");
  const source = context.createBufferSource();
  const gain = context.createGain();
  const pan = context.createStereoPanner();
  const filter = context.createBiquadFilter();
  source.buffer = buffer;
  source.loop = options.loop ?? false;
  const rateTo = automation(context, source.playbackRate, mix.rate, at);
  filter.type = "lowpass";
  filter.Q.value = 0;
  const filterTo = automation(
    context,
    filter.frequency,
    Math.min(context.sampleRate / 2, mix.cutoff),
    at,
  );
  const panTo = automation(context, pan.pan, mix.pan, at);
  let initialGain = mix.gain;
  if (fade > 0) initialGain = 0;
  const gainTo = automation(context, gain.gain, initialGain, at);
  if (fade > 0) {
    gainTo(mix.gain, at, fade);
  }
  let ended = false;
  let stopping = false;
  const disconnect = () => {
    if (ended) return;
    ended = true;
    source.removeEventListener("ended", disconnect);
    source.disconnect();
    source.buffer = null;
    filter.disconnect();
    pan.disconnect();
    gain.disconnect();
  };
  source.addEventListener("ended", disconnect, { once: true });
  try {
    source.connect(filter).connect(pan).connect(gain).connect(
      options.destination ?? context.destination,
    );
    source.start(at, offset);
  } catch (error) {
    disconnect();
    throw error;
  }
  return {
    update(next: Mix, duration = 0.02, time = context.currentTime) {
      if (ended || stopping) return;
      validate(next);
      if (
        !Number.isFinite(duration) || duration < 0 || !Number.isFinite(time) ||
        time < context.currentTime
      ) throw new RangeError("Invalid update timing");
      gainTo(next.gain, time, duration);
      panTo(next.pan, time, duration);
      rateTo(next.rate, time, duration);
      filterTo(Math.min(context.sampleRate / 2, next.cutoff), time, duration);
    },
    stop(duration = 0, time = context.currentTime) {
      if (ended || stopping) return;
      if (
        !Number.isFinite(duration) || duration < 0 || !Number.isFinite(time) ||
        time < context.currentTime
      ) throw new RangeError("Invalid stop timing");
      stopping = true;
      gainTo(0, time, duration);
      source.stop(time + duration);
    },
    dispose() {
      if (!ended) source.stop();
      disconnect();
    },
  };
}
