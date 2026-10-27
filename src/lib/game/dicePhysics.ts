import { Body, ConvexPolyhedron, Plane, Vec3, World } from "cannon-es";
import {
  D20_FACES,
  D20_VERTICES,
  INRADIUS,
  normalize,
  type Vec3 as GeometryVec3,
} from "./d20Geometry";

// Headless d20 throw: a rigid-body simulation (cannon-es, no renderer) sampled
// into a transform track the die components play back via the Web Animations
// API. Presentation only — the rolled value comes from game state; the settle
// tail (settleWaapiKeyframes) orients the resting body onto the value face.
//
// The world runs in CSS axis labels: x right, y DOWN, z toward the viewer, one
// unit = one icosahedron edge (= FACE_EDGE_PX on screen). Positions in the
// track are relative to the die's rest position, so playback settles the die
// exactly into its slot.

export const FLIGHT_BUDGET_MS = 1600;
export const SETTLE_TAIL_MS = 260;

const PX_PER_UNIT = 18;
const STEP_S = 1 / 120;
const STEPS_PER_SAMPLE = 2; // 60Hz track
const GRAVITY = 120;
const RESTITUTION = 0.38;
const FRICTION = 0.5;
const ANGULAR_DAMPING = 0.5;
const LINEAR_DAMPING = 0.08;
// Rest thresholds sit above convex-body contact jitter: below these the
// residual motion is sub-pixel and the settle tail takes over the pose anyway.
const REST_SPEED = 0.4;
const REST_SPIN = 0.8;
const REST_STEPS = 6;

export type DiceFlightSample = {
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
};

export type DiceFlightTrack = {
  readonly samples: readonly DiceFlightSample[];
  readonly durationMs: number;
  readonly restQuaternion: readonly [number, number, number, number];
  readonly restAchieved: boolean;
};

// cannon-es derives face normals from winding; the icosahedron's index triples
// aren't guaranteed outward, so orient each one by its geometric normal.
function outwardFaces(): number[][] {
  return D20_FACES.map((face) => {
    const [a, b, c] = face.map((i) => D20_VERTICES[i]!);
    const n = {
      x: (b!.y - a!.y) * (c!.z - a!.z) - (b!.z - a!.z) * (c!.y - a!.y),
      y: (b!.z - a!.z) * (c!.x - a!.x) - (b!.x - a!.x) * (c!.z - a!.z),
      z: (b!.x - a!.x) * (c!.y - a!.y) - (b!.y - a!.y) * (c!.x - a!.x),
    };
    const centroid = {
      x: (a!.x + b!.x + c!.x) / 3,
      y: (a!.y + b!.y + c!.y) / 3,
      z: (a!.z + b!.z + c!.z) / 3,
    };
    const outward = n.x * centroid.x + n.y * centroid.y + n.z * centroid.z > 0;
    return outward ? [...face] : [...face].reverse();
  });
}

function randomUnitAxis(random: () => number): GeometryVec3 {
  for (;;) {
    const axis = normalize({ x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1 });
    if (Number.isFinite(axis.x)) return axis;
  }
}

export function simulateD20Throw(random: () => number = Math.random): DiceFlightTrack {
  const world = new World({ gravity: new Vec3(0, GRAVITY, 0) });
  world.defaultContactMaterial.restitution = RESTITUTION;
  world.defaultContactMaterial.friction = FRICTION;

  const ground = new Body({ shape: new Plane() });
  ground.quaternion.setFromEuler(Math.PI / 2, 0, 0); // plane normal +z → -y, out of the floor
  world.addBody(ground);

  const die = new Body({
    mass: 1,
    shape: new ConvexPolyhedron({
      vertices: D20_VERTICES.map((v) => new Vec3(v.x, v.y, v.z)),
      faces: outwardFaces(),
    }),
    angularDamping: ANGULAR_DAMPING,
    linearDamping: LINEAR_DAMPING,
  });

  die.position.set((random() * 2 - 1) * 0.7, -(INRADIUS + 2.6 + random()), (random() * 2 - 1) * 0.4);
  const facing = randomUnitAxis(random);
  die.quaternion.setFromAxisAngle(new Vec3(facing.x, facing.y, facing.z), random() * 2 * Math.PI);
  die.velocity.set((random() * 2 - 1) * 0.5, 3 + random() * 1.5, (random() * 2 - 1) * 0.3);
  const spinAxis = randomUnitAxis(random);
  const spin = 5 + random() * 5;
  die.angularVelocity.set(spinAxis.x * spin, spinAxis.y * spin, spinAxis.z * spin);
  world.addBody(die);

  const raw: { tMs: number; p: Vec3; q: [number, number, number, number] }[] = [
    { tMs: 0, p: die.position.clone(), q: [die.quaternion.x, die.quaternion.y, die.quaternion.z, die.quaternion.w] },
  ];

  let restSteps = 0;
  let steps = 0;
  const maxSteps = Math.round(FLIGHT_BUDGET_MS / (STEP_S * 1000));
  let restAchieved = false;
  while (steps < maxSteps) {
    world.step(STEP_S);
    steps += 1;
    if (die.velocity.length() < REST_SPEED && die.angularVelocity.length() < REST_SPIN) {
      restSteps += 1;
      if (restSteps >= REST_STEPS) {
        restAchieved = true;
        break;
      }
    } else {
      restSteps = 0;
    }
    if (steps % STEPS_PER_SAMPLE === 0) {
      raw.push({
        tMs: (steps * STEP_S * 1000) | 0,
        p: die.position.clone(),
        q: [die.quaternion.x, die.quaternion.y, die.quaternion.z, die.quaternion.w],
      });
    }
  }

  // If the budget expired mid-wobble, end the track at its calmest late
  // window so playback always hands over a still die to the settle tail.
  if (!restAchieved) {
    const calmEnd = lastCalmSample(raw);
    if (calmEnd !== null) {
      raw.length = calmEnd + 1;
      restAchieved = true;
    }
  }

  const rest = raw.at(-1)!.p;
  const samples = raw.map((s) => ({
    tMs: s.tMs,
    x: (s.p.x - rest.x) * PX_PER_UNIT,
    y: (s.p.y - rest.y) * PX_PER_UNIT,
    z: (s.p.z - rest.z) * PX_PER_UNIT,
    qx: s.q[0],
    qy: s.q[1],
    qz: s.q[2],
    qw: s.q[3],
  }));
  const restQuaternion = raw.at(-1)!.q;
  return {
    samples,
    durationMs: raw.at(-1)!.tMs,
    restQuaternion,
    restAchieved,
  };
}

// Last index whose trailing CALM_SAMPLES span moves under CALM_STEP_PX per
// sample — motion below ~15px/s, invisible at the handover to the tail.
const CALM_SAMPLES = 5;
const CALM_STEP_PX = 0.25;

const SETTLE_HOP_PX = 3;

function translate3d(x: number, y: number, z: number): string {
  return `translate3d(${x}px, ${y}px, ${z}px)`;
}

// Unit quaternion → CSS matrix3d (column-major), rotation only.
function quaternionToMatrix3d([x, y, z, w]: readonly [number, number, number, number]): string {
  const xx = x * x;
  const xy = x * y;
  const xz = x * z;
  const yy = y * y;
  const yz = y * z;
  const zz = z * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  // row-major rotation entries
  const m = [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ] as const;
  return `matrix3d(${m[0]},${m[3]},${m[6]},0,${m[1]},${m[4]},${m[7]},0,${m[2]},${m[5]},${m[8]},0,0,0,0,1)`;
}

const IDENTITY_MATRIX3D = "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)";

export function flightWaapiKeyframes(track: DiceFlightTrack): { offset: number; transform: string }[] {
  return track.samples.map((s, i) => ({
    offset: i === track.samples.length - 1 ? 1 : s.tMs / track.durationMs,
    transform: `${translate3d(s.x, s.y, s.z)} ${quaternionToMatrix3d([s.qx, s.qy, s.qz, s.qw])}`,
  }));
}

// The settle tail: from the flight's rest pose, a short hop while the body
// snaps past the value-face orientation and eases into it — the "settling
// onto the result face" beat. Ends exactly at identity, the pose DieFaces
// draws with the value face front.
export function settleWaapiKeyframes(
  track: DiceFlightTrack,
): { offset: number; transform: string; easing?: string }[] {
  const [qx, qy, qz, qw] = track.restQuaternion;
  const spin = Math.hypot(qx, qy, qz);
  const axis = spin < 1e-6 ? { x: 0, y: 0, z: 1 } : { x: qx / spin, y: qy / spin, z: qz / spin };
  const angle = 2 * Math.acos(Math.min(1, Math.max(-1, qw)));
  // overshoot 12% past identity along the same snap arc
  const half = (-angle * 0.12) / 2;
  const overshoot = [axis.x * Math.sin(half), axis.y * Math.sin(half), axis.z * Math.sin(half), Math.cos(half)] as const;
  return [
    {
      offset: 0,
      transform: `${translate3d(0, 0, 0)} ${quaternionToMatrix3d(track.restQuaternion)}`,
      easing: "cubic-bezier(0.3, 0.6, 0.3, 1)",
    },
    {
      offset: 0.55,
      transform: `${translate3d(0, -SETTLE_HOP_PX, 0)} ${quaternionToMatrix3d(overshoot)}`,
      easing: "ease-out",
    },
    { offset: 1, transform: `${translate3d(0, 0, 0)} ${IDENTITY_MATRIX3D}` },
  ];
}

function lastCalmSample(
  raw: { tMs: number; p: Vec3; q: readonly number[] }[],
): number | null {
  const step = (a: { p: Vec3 }, b: { p: Vec3 }) =>
    Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z) * PX_PER_UNIT;
  for (let end = raw.length - 1; end >= CALM_SAMPLES; end -= 1) {
    let calm = true;
    for (let i = end - CALM_SAMPLES + 1; i <= end; i += 1) {
      if (step(raw[i]!, raw[i - 1]!) > CALM_STEP_PX) {
        calm = false;
        break;
      }
    }
    if (calm) return end;
  }
  return null;
}
