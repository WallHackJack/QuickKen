import { describe, expect, it } from 'vitest';
import { countSolutions } from '../src/engine/backtrack';
import { DIGIT_PRESETS, makeDigitSet } from '../src/engine/digits';
import { generatePuzzle } from '../src/engine/generator';
import { logicSolve } from '../src/engine/logic';
import { getOperator } from '../src/engine/operators';
import { makeContext, masksToDigits } from '../src/engine/propagate';
import type { PuzzleDef } from '../src/engine/puzzle';
import { createLogicState } from '../src/engine/techniques';
import { findNextStep } from '../src/engine/logic';

describe('operators', () => {
  it('evaluate', () => {
    expect(getOperator('add').evaluate([1, 2, 3])).toBe(6);
    expect(getOperator('sub').evaluate([2, 5])).toBe(3);
    expect(getOperator('div').evaluate([2, 6])).toBe(3);
    expect(getOperator('div').evaluate([0, 6])).toBeNull();
    expect(getOperator('mod').evaluate([3, 7])).toBe(1);
    expect(getOperator('range').evaluate([4, 1, 3])).toBe(3);
  });
});

describe('hand-made puzzle', () => {
  // 3x3:  1 2 3 / 2 3 1 / 3 1 2
  const p: PuzzleDef = {
    size: 3,
    digits: DIGIT_PRESETS.standard(3),
    cages: [
      { cells: [0, 1], op: 'add', target: 3 },
      { cells: [2, 5], op: 'add', target: 4 },
      { cells: [3, 6], op: 'mul', target: 6 },
      { cells: [4, 7, 8], op: 'add', target: 6 },
    ],
  };
  it('has a unique solution found by both solvers', () => {
    const ctx = makeContext(p);
    const r = countSolutions(ctx, 5);
    expect(r.count).toBe(1);
    const trace = logicSolve(ctx);
    expect(trace.solved).toBe(true);
    expect(r.solution).toEqual([0, 1, 2, 1, 2, 0, 2, 0, 1]);
  });
  it('gives a hint with an explanation', () => {
    const step = findNextStep(createLogicState(makeContext(p)));
    expect(step).not.toBeNull();
    expect(step!.explain.length).toBeGreaterThan(10);
  });
});

const configs: [string, Parameters<typeof generatePuzzle>[0]][] = [
  ['4x4 standard', { size: 4, digits: DIGIT_PRESETS.standard(4), seed: 'a' }],
  ['6x6 standard', { size: 6, digits: DIGIT_PRESETS.standard(6), seed: 'b' }],
  ['5x5 zero-based', { size: 5, digits: DIGIT_PRESETS.zeroBased(5), seed: 'c' }],
  ['6x6 centered (negatives)', { size: 6, digits: DIGIT_PRESETS.centered(6), seed: 'd' }],
  ['5x5 primes, new ops', { size: 5, digits: DIGIT_PRESETS.primes(5), seed: 'e', operators: [{ id: 'add', weight: 2 }, { id: 'max', weight: 1 }, { id: 'min', weight: 1 }, { id: 'mod', weight: 1 }, { id: 'range', weight: 1 }] }],
  ['4x4 custom digits', { size: 4, digits: makeDigitSet([3, 7, 10, 12], ['A', 'B', 'C', 'D']), seed: 'f' }],
  ['7x7 standard', { size: 7, digits: DIGIT_PRESETS.standard(7), seed: 'g' }],
];

describe('generator', () => {
  for (const [name, opts] of configs) {
    it(name, () => {
      const t0 = performance.now();
      const { puzzle, attempts } = generatePuzzle(opts);
      const ctx = makeContext(puzzle);
      expect(countSolutions(ctx, 2).count).toBe(1);
      const trace = logicSolve(ctx);
      expect(trace.solved).toBe(true);
      const s = createLogicState(ctx);
      for (const st of trace.steps) {
        for (const pl of st.placements) s.masks[pl.cell] = 1 << pl.digit;
        for (const e of st.eliminations) s.masks[e.cell] &= ~(1 << e.digit);
      }
      expect(masksToDigits(s.masks)).toEqual(puzzle.solution);
      // eslint-disable-next-line no-console
      console.log(`${name}: ${puzzle.meta?.rating} (${puzzle.meta?.difficulty}), ${trace.steps.length} steps, ${attempts} attempts, ${(performance.now() - t0).toFixed(0)}ms; techniques: ${[...new Set(trace.steps.map((x) => x.technique))].join(', ')}`);
    });
  }

  it('is deterministic for a seed', () => {
    const a = generatePuzzle({ size: 5, digits: DIGIT_PRESETS.standard(5), seed: 'daily-2026-10-19' }).puzzle;
    const b = generatePuzzle({ size: 5, digits: DIGIT_PRESETS.standard(5), seed: 'daily-2026-10-19' }).puzzle;
    expect(a.cages).toEqual(b.cages);
  });

  it('can target a rating', () => {
    const { puzzle } = generatePuzzle({ size: 6, digits: DIGIT_PRESETS.standard(6), seed: 'hard', ratings: ['Hard', 'Expert'] });
    expect(['Hard', 'Expert']).toContain(puzzle.meta?.rating);
  });
});
