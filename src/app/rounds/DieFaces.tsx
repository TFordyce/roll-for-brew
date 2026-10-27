"use client";

import type { CSSProperties } from "react";
import {
  type Vec3,
  type Basis,
  D20_FACES,
  D20_VERTICES,
  cross,
  dot,
  faceCenter,
  normalize,
  scaleVec,
  subtract,
} from "@/lib/game/d20Geometry";

const FACE_EDGE_PX = 18;
export const DIE_SIZE_PX = 36;

const ORIENTED_VERTICES = alignVerticesToFront(D20_VERTICES);
const FACE_PLANES = D20_FACES.map((face) => {
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

function alignVerticesToFront(vertices: Vec3[]): Vec3[] {
  const numberFaceBasis = faceBasis(vertices, D20_FACES[0]!);
  return vertices.map((v) => {
    const framed = {
      x: dot(v, numberFaceBasis.x),
      y: dot(v, numberFaceBasis.y),
      z: dot(v, numberFaceBasis.z),
    };
    return { x: framed.y, y: -framed.x, z: framed.z };
  });
}

function faceBasis(vertices: Vec3[], face: readonly [number, number, number]): Basis {
  const center = faceCenter(vertices, face as [number, number, number]);
  const z = normalize(center);
  const x = normalize(subtract(vertices[face[0]]!, center));
  return { x, y: cross(z, x), z };
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
    backgroundColor: shaded(index === 0 ? EMBER_BRIGHT : EMBER, brightness),
  };
});

export function DieFaces({ value }: { value?: number }) {
  return (
    <>
      {FACE_STYLES.map((style, index) => (
        <span key={index} className="absolute block" style={style}>
          {index === 0 && value !== undefined ? (
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
    </>
  );
}
