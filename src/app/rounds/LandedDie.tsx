"use client";

import type { CSSProperties } from "react";
import type { DiceRevealEntrance } from "./useDiceReveal";

type Vec3 = { readonly x: number; readonly y: number; readonly z: number };
type Basis = { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3 };

const FACE_EDGE_PX = 18;
const DIE_SIZE_PX = 36;
const PENTAGON_RADIUS = 1 / (2 * Math.sin(Math.PI / 5));
const APEX_RISE = Math.sqrt(1 - PENTAGON_RADIUS * PENTAGON_RADIUS);
const BAND_RISE = PENTAGON_RADIUS / 2;
const CIRCUMRADIUS = APEX_RISE + BAND_RISE;

function pentagonRing(y: number, offset: number): Vec3[] {
  return Array.from({ length: 5 }, (_, k) => {
    const angle = offset + (k * 2 * Math.PI) / 5;
    return { x: PENTAGON_RADIUS * Math.cos(angle), y, z: PENTAGON_RADIUS * Math.sin(angle) };
  });
}

const VERTICES: Vec3[] = [
  { x: 0, y: -CIRCUMRADIUS, z: 0 },
  ...pentagonRing(-BAND_RISE, 0),
  ...pentagonRing(BAND_RISE, Math.PI / 5),
  { x: 0, y: CIRCUMRADIUS, z: 0 },
];

const TOP_APEX = 0;
const BOTTOM_APEX = 11;
const ringNext = (k: number) => (k + 1) % 5;

const FACES: [number, number, number][] = Array.from(
  { length: 5 },
  (_, k): [number, number, number][] => {
    const next = ringNext(k);
    return [
      [TOP_APEX, 1 + k, 1 + next],
      [1 + k, 1 + next, 6 + k],
      [6 + k, 1 + next, 6 + next],
      [BOTTOM_APEX, 6 + next, 6 + k],
    ];
  },
).flat();

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scaleVec = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });
const normalize = (v: Vec3): Vec3 => scaleVec(v, 1 / Math.hypot(v.x, v.y, v.z));
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function faceCenter(vertices: Vec3[], face: [number, number, number]): Vec3 {
  const [a, b, c] = face.map((i) => vertices[i]!);
  return scaleVec(
    { x: a!.x + b!.x + c!.x, y: a!.y + b!.y + c!.y, z: a!.z + b!.z + c!.z },
    1 / 3,
  );
}

function faceBasis(vertices: Vec3[], face: [number, number, number]): Basis {
  const center = faceCenter(vertices, face);
  const z = normalize(center);
  const x = normalize(subtract(vertices[face[0]]!, center));
  return { x, y: cross(z, x), z };
}

const NUMBER_FACE = 0;
const numberFaceBasis = faceBasis(VERTICES, FACES[NUMBER_FACE]!);

function alignNumberFaceToFront(v: Vec3): Vec3 {
  const framed = {
    x: dot(v, numberFaceBasis.x),
    y: dot(v, numberFaceBasis.y),
    z: dot(v, numberFaceBasis.z),
  };
  return { x: framed.y, y: -framed.x, z: framed.z };
}

const ORIENTED_VERTICES = VERTICES.map(alignNumberFaceToFront);
const FACE_PLANES = FACES.map((face) => {
  const basis = faceBasis(ORIENTED_VERTICES, face);
  const center = faceCenter(ORIENTED_VERTICES, face);
  return { basis, inradius: Math.hypot(center.x, center.y, center.z) };
});

const LIGHT = normalize({ x: -0.45, y: -0.7, z: 0.55 });
const EMBER: [number, number, number] = [122, 59, 46];
const EMBER_BRIGHT: [number, number, number] = [179, 84, 63];

function shaded(rgb: [number, number, number], brightness: number): string {
  return `rgb(${rgb.map((c) => Math.round(c * brightness)).join(",")})`;
}

const FACE_WIDTH_PX = (Math.sqrt(3) / 2) * FACE_EDGE_PX;

const FACE_STYLES: CSSProperties[] = FACE_PLANES.map(({ basis, inradius }, index) => {
  const brightness = 0.58 + 0.42 * Math.max(0, dot(basis.z, LIGHT));
  return {
    width: FACE_WIDTH_PX,
    height: FACE_EDGE_PX,
    left: (DIE_SIZE_PX - FACE_WIDTH_PX) / 2,
    top: (DIE_SIZE_PX - FACE_EDGE_PX) / 2,
    clipPath: "polygon(100% 50%, 0% 100%, 0% 0%)",
    transform: `matrix3d(${basis.x.x},${basis.x.y},${basis.x.z},0,${basis.y.x},${basis.y.y},${basis.y.z},0,${basis.z.x},${basis.z.y},${basis.z.z},0,0,0,0,1) translateZ(${inradius * FACE_EDGE_PX}px)`,
    backgroundColor: shaded(index === NUMBER_FACE ? EMBER_BRIGHT : EMBER, brightness),
  };
});

export function LandedDie({
  value,
  entrance,
  onDismiss,
}: {
  value: number;
  entrance: DiceRevealEntrance;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
      title="Back to the roll row"
      aria-label="Back to the roll row"
      className="relative shrink-0 cursor-pointer [perspective:220px]"
      style={{ width: DIE_SIZE_PX, height: DIE_SIZE_PX }}
    >
      <span
        className={`absolute inset-0 block [transform-style:preserve-3d] ${
          entrance === "landing" ? "animate-die-land motion-reduce:animate-none" : ""
        }`}
      >
        {FACE_STYLES.map((style, index) => (
          <span key={index} className="absolute block" style={style}>
            {index === NUMBER_FACE ? (
              <span
                className="absolute font-display font-semibold text-parchment text-[9px]"
                style={{
                  left: "33%",
                  top: "50%",
                  transform: "translate(-50%, -50%) rotate(90deg)",
                  lineHeight: 1,
                }}
              >
                {value}
              </span>
            ) : null}
          </span>
        ))}
      </span>
    </button>
  );
}
