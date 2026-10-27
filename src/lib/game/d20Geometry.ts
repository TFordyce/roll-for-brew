// Unit icosahedron (edge length 1) shared by the CSS die renderer (DieFaces)
// and the headless physics simulation (dicePhysics): one vertex set, one face
// indexing, so the simulated body and the rendered die are the same shape.
export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };
export type Basis = { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3 };

const PENTAGON_RADIUS = 1 / (2 * Math.sin(Math.PI / 5));
const BAND_RISE = PENTAGON_RADIUS / 2;
const APEX_RISE = Math.sqrt(1 - PENTAGON_RADIUS * PENTAGON_RADIUS);
const CIRCUMRADIUS = APEX_RISE + BAND_RISE;

// The on-screen edge length both consumers render at: DieFaces draws faces at
// this scale, and dicePhysics converts simulated units to px with it. One
// constant, so the track can never desync from the rendered die.
export const EDGE_PX = 18;

function pentagonRing(y: number, offset: number): Vec3[] {
  return Array.from({ length: 5 }, (_, k) => {
    const angle = offset + (k * 2 * Math.PI) / 5;
    return { x: PENTAGON_RADIUS * Math.cos(angle), y, z: PENTAGON_RADIUS * Math.sin(angle) };
  });
}

export const D20_VERTICES: Vec3[] = [
  { x: 0, y: -CIRCUMRADIUS, z: 0 },
  ...pentagonRing(-BAND_RISE, 0),
  ...pentagonRing(BAND_RISE, Math.PI / 5),
  { x: 0, y: CIRCUMRADIUS, z: 0 },
];

export const D20_FACES: [number, number, number][] = Array.from(
  { length: 5 },
  (_, k): [number, number, number][] => {
    const next = (k + 1) % 5;
    return [
      [0, 1 + k, 1 + next],
      [1 + k, 1 + next, 6 + k],
      [6 + k, 1 + next, 6 + next],
      [11, 6 + next, 6 + k],
    ];
  },
).flat();

export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const scaleVec = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
export const normalize = (v: Vec3): Vec3 => scaleVec(v, 1 / Math.hypot(v.x, v.y, v.z));
export const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export function faceCenter(vertices: Vec3[], face: [number, number, number]): Vec3 {
  const [a, b, c] = face.map((i) => vertices[i]!);
  return scaleVec(
    { x: a!.x + b!.x + c!.x, y: a!.y + b!.y + c!.y, z: a!.z + b!.z + c!.z },
    1 / 3,
  );
}

// Distance from the center to any face plane — the resting height of the
// body's center when it lies flat on a face.
const firstFaceCenter = faceCenter(D20_VERTICES, D20_FACES[0]!);
export const INRADIUS = Math.hypot(firstFaceCenter.x, firstFaceCenter.y, firstFaceCenter.z);
