import { describe, expect, it } from 'vitest';
import { cageLoops, insetLoop } from '../src/render/cageShape';

describe('cage outline', () => {
  it('traces an L-shape as one 6-corner loop', () => {
    const loops = cageLoops([0, 1, 3], 3); // (0,0) (0,1) (1,0)
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(6);
  });
  it('insets towards the interior', () => {
    const [loop] = cageLoops([0], 3);
    const inset = insetLoop(loop, 0.1).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)].join(','));
    expect(inset.sort()).toEqual(['0.1,0.1', '0.1,0.9', '0.9,0.1', '0.9,0.9']);
  });
  it('splits diagonal pinch points into clean loops', () => {
    // 2x2 ring with a hole in the middle of a 3x3: every cell except the centre.
    const loops = cageLoops([0, 1, 2, 3, 5, 6, 7, 8], 3);
    expect(loops).toHaveLength(2);
  });
});
