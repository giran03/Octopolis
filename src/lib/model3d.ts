// Minimal STL (binary and ASCII) and OBJ parsing for the inspector.

/** Triangle positions: 9 floats per triangle. */
export interface Mesh {
  readonly positions: Float32Array;
  readonly triangles: number;
}

const MAX_TRIANGLES = 2_000_000;

function toMesh(values: number[]): Mesh {
  return { positions: Float32Array.from(values), triangles: values.length / 9 };
}

export function parseStl(buffer: ArrayBuffer): Mesh {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length)));
  const view = new DataView(buffer);
  const binaryCount = buffer.byteLength >= 84 ? view.getUint32(80, true) : -1;
  const isBinary = binaryCount >= 0 && 84 + binaryCount * 50 === buffer.byteLength;
  if (!isBinary && head.trimStart().startsWith("solid")) {
    const text = new TextDecoder().decode(bytes);
    const values: number[] = [];
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    return toMesh(values.slice(0, values.length - (values.length % 9)));
  }
  if (!isBinary) throw new Error("This STL file is damaged");
  const count = Math.min(binaryCount, MAX_TRIANGLES);
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(base + k * 4, true);
  }
  return { positions, triangles: count };
}

export function parseObj(text: string): Mesh {
  const verts: number[][] = [];
  const values: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      verts.push([Number(x), Number(y), Number(z)]);
    } else if (line.startsWith("f ")) {
      const idx = line
        .split(/\s+/)
        .slice(1)
        .map((p) => {
          const n = parseInt(p, 10);
          return n < 0 ? verts.length + n : n - 1;
        });
      for (let i = 1; i + 1 < idx.length && values.length / 9 < MAX_TRIANGLES; i++) {
        for (const v of [idx[0], idx[i], idx[i + 1]]) {
          const p = verts[v];
          if (!p) throw new Error("This OBJ file refers to a missing vertex");
          values.push(p[0], p[1], p[2]);
        }
      }
    }
  }
  return toMesh(values);
}

export interface Bounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export function boundsOf(m: Mesh): Bounds {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a], m.positions[i]);
    max[a] = Math.max(max[a], m.positions[i]);
  }
  const center = [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
  return { center, radius };
}
