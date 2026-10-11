/** A physics-only numeric fixture; each source has 75 explicit lanes. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Rigid = {
  kind: number;
  mass: number;
  gravity: number;
  linearDamping: number;
  angularDamping: number;
  canSleep: boolean;
  continuous: boolean;
  velocity: Vec3;
  angularVelocity: Vec3;
  sleeping: boolean;
  sleepTime: number;
};
export type Walker = {
  slope: number;
  step: number;
  snap: number;
  push: number;
  velocity: Vec3;
  grounded: boolean;
  ground: number;
  normal: Vec3;
};
export type Source = {
  id: number;
  position: Vec3;
  rotation: Quat;
  size: Vec3;
  shape: number;
  radius: number;
  height: number;
  offset: Vec3;
  friction: number;
  restitution: number;
  trigger: boolean;
  layer: number;
  mask: number;
  body?: Rigid;
  walker?: Walker;
  planes: Quat[];
};

export function rigid(fields: Partial<Rigid> = {}): Rigid {
  return {
    kind: 1,
    mass: 1,
    gravity: 1,
    linearDamping: 0,
    angularDamping: 0.05,
    canSleep: true,
    continuous: true,
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    sleeping: false,
    sleepTime: 0,
    ...fields,
  };
}

export function box(
  id: number,
  position: Vec3,
  size: Vec3 = [1, 1, 1],
  fields: Partial<Source> = {},
): Source {
  return {
    id,
    position,
    size,
    rotation: [0, 0, 0, 1],
    shape: 0,
    radius: 0.5,
    height: 2,
    offset: [0, 0, 0],
    friction: 0.6,
    restitution: 0,
    trigger: false,
    layer: 1,
    mask: 65535,
    planes: [],
    ...fields,
  };
}

export function walker(position: Vec3, fields: Partial<Walker> = {}): Source {
  return box(100, position, [1, 1, 1], {
    shape: 2,
    radius: 0.4,
    height: 1.8,
    offset: [0, 0.9, 0],
    walker: {
      slope: 50,
      step: 0.4,
      snap: 0.3,
      push: 1,
      velocity: [0, 0, 0],
      grounded: false,
      ground: 0,
      normal: [0, 0, 0],
      ...fields,
    },
  });
}

export function stack(count: number, canSleep = true): Source[] {
  const sources = [box(1, [0, -0.5, 0], [40, 1, 40])];
  for (let i = 0; i < count; i++) {
    sources.push(box(i + 2, [0, 0.5 + i, 0], [1, 1, 1], {
      body: rigid({ canSleep }),
    }));
  }
  return sources;
}

type Guest = { call(name: string, lanes: Float32Array): unknown };
const header = 14;
const stride = 75;

export class Fixture {
  lanes: Float32Array;

  constructor(readonly guest: Guest, readonly sources: Source[]) {
    this.lanes = new Float32Array(header + sources.length * stride);
    this.lanes[0] = 1 / 60;
    this.lanes[13] = sources.length;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const o = header + i * stride;
      this.lanes.set([
        s.id,
        ...s.position,
        ...s.rotation,
        ...s.size,
        s.shape,
        s.radius,
        s.height,
        ...s.offset,
        s.friction,
        s.restitution,
        Number(s.trigger),
      ], o);
      if (s.body) {
        const b = s.body;
        this.lanes.set([
          b.kind,
          b.mass,
          b.gravity,
          b.linearDamping,
          b.angularDamping,
          Number(b.canSleep),
          Number(b.continuous),
          ...b.velocity,
          ...b.angularVelocity,
          Number(b.sleeping),
          b.sleepTime,
        ], o + 20);
      }
      if (s.walker) {
        const w = s.walker;
        this.lanes.set([
          1,
          w.slope,
          w.step,
          w.snap,
          w.push,
          ...w.velocity,
          Number(w.grounded),
          w.ground,
          ...w.normal,
        ], o + 35);
      }
      if (s.planes.length > 6) throw new Error("fixture supports six planes");
      this.lanes[o + 48] = s.planes.length;
      for (let p = 0; p < s.planes.length; p++) {
        this.lanes.set(s.planes[p], o + 49 + p * 4);
      }
      this.lanes[o + 73] = s.layer;
      this.lanes[o + 74] = s.mask;
    }
  }

  advance(
    ticks: number,
    velocity: Vec3 = [0, 0, 0],
    jump = false,
    move = false,
  ) {
    this.lanes.set(velocity, 2);
    this.lanes[1] = Number(jump);
    this.lanes[12] = Number(move);
    for (let tick = 0; tick < ticks; tick++) {
      this.lanes = this.guest.call("step", this.lanes) as Float32Array;
    }
    return this;
  }

  source(id: number) {
    const index = this.sources.findIndex((s) => s.id === id);
    if (index < 0) throw new Error(`missing fixture source ${id}`);
    const o = header + index * stride;
    const a = this.lanes;
    return {
      position: Array.from(a.subarray(o + 1, o + 4)),
      velocity: Array.from(a.subarray(o + 27, o + 30)),
      sleeping: a[o + 33] === 1,
      grounded: a[o + 43] === 1,
      ground: a[o + 44],
    };
  }

  query(
    mode: number,
    origin: Vec3,
    direction: Vec3 = [0, 0, 0],
    reach = 20,
    radius = 0.5,
    skip = 0,
    mask = 65535,
  ) {
    const lanes = this.lanes.slice();
    lanes[1] = mode;
    lanes.set(direction, 2);
    lanes[5] = reach;
    lanes[6] = radius;
    lanes[7] = skip;
    lanes.set(origin, 8);
    lanes[11] = mask;
    return Array.from(this.guest.call("query", lanes) as Float32Array);
  }
}
