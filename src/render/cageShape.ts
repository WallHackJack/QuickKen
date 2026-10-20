// Traces the outline of a cage (union of grid cells) into closed loops, then insets it.
// Coordinates are in grid units; multiply by cell size to draw.

type Pt = [number, number];

export function cageLoops(cells: number[], n: number): Pt[][] {
  const set = new Set(cells);
  const inCage = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && set.has(r * n + c);
  // Directed boundary edges, clockwise on screen (y down): interior is on the right-hand side.
  const edges = new Map<string, Pt[]>();
  const add = (a: Pt, b: Pt) => {
    const k = `${a[0]},${a[1]}`;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k)!.push(b);
  };
  for (const cell of cells) {
    const r = Math.floor(cell / n), c = cell % n;
    if (!inCage(r - 1, c)) add([c, r], [c + 1, r]);
    if (!inCage(r, c + 1)) add([c + 1, r], [c + 1, r + 1]);
    if (!inCage(r + 1, c)) add([c + 1, r + 1], [c, r + 1]);
    if (!inCage(r, c - 1)) add([c, r + 1], [c, r]);
  }

  const loops: Pt[][] = [];
  const take = (from: Pt, dir: Pt | null): Pt | null => {
    const k = `${from[0]},${from[1]}`;
    const outs = edges.get(k);
    if (!outs?.length) return null;
    let idx = 0;
    if (dir && outs.length > 1) {
      // At pinch points prefer turning right (towards the interior), then straight, then left.
      const score = (b: Pt) => {
        const d: Pt = [b[0] - from[0], b[1] - from[1]];
        if (d[0] === -dir[1] && d[1] === dir[0]) return 0;
        if (d[0] === dir[0] && d[1] === dir[1]) return 1;
        return 2;
      };
      idx = outs.reduce((best, b, i) => (score(b) < score(outs[best]) ? i : best), 0);
    }
    const [b] = outs.splice(idx, 1);
    return b;
  };

  for (const [k, outs] of edges) {
    while (outs.length) {
      const start = k.split(',').map(Number) as Pt;
      const loop: Pt[] = [start];
      let cur = start;
      let dir: Pt | null = null;
      for (let guard = 0; guard < 4 * cells.length + 4; guard++) {
        const next = take(cur, dir);
        if (!next) break;
        dir = [next[0] - cur[0], next[1] - cur[1]];
        cur = next;
        if (cur[0] === start[0] && cur[1] === start[1]) break;
        loop.push(cur);
      }
      loops.push(simplify(loop));
    }
  }
  return loops;
}

/** Drop collinear points. */
function simplify(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross !== 0) out.push(b);
  }
  return out;
}

/** Move each vertex inwards by `d` (works exactly for axis-aligned polygons). */
export function insetLoop(loop: Pt[], d: number): Pt[] {
  return loop.map((b, i) => {
    const a = loop[(i - 1 + loop.length) % loop.length], c = loop[(i + 1) % loop.length];
    const d1 = norm([b[0] - a[0], b[1] - a[1]]), d2 = norm([c[0] - b[0], c[1] - b[1]]);
    // Inward normal of a clockwise (y-down) edge with direction (dx, dy) is (-dy, dx).
    return [b[0] + d * (-d1[1] - d2[1]), b[1] + d * (d1[0] + d2[0])] as Pt;
  });
}

const norm = (v: Pt): Pt => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
