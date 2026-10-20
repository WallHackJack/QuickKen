// Step-by-step logical solver. Always takes the cheapest available step, so the trace measures
// the reasoning a puzzle actually needs (used for difficulty, hints and grading).

import type { SolveContext } from './propagate';
import { applyStep, createLogicState, isContradiction, TECHNIQUES, type LogicState, type Step } from './techniques';

export type Rating = 'Easy' | 'Medium' | 'Hard' | 'Expert' | 'Fiendish';

export interface SolveTrace {
  steps: Step[];
  solved: boolean;
  /** True when the solver stopped because a step exceeded maxCost. */
  exceeded: boolean;
  maxCost: number;
  totalCost: number;
  difficulty: number;
  rating: Rating;
}

export function findNextStep(s: LogicState, maxCost = Infinity): Step | null {
  let best: Step | null = null;
  for (const t of TECHNIQUES) {
    if (t.baseCost > maxCost) break;
    if (best && t.baseCost >= best.cost) break;
    const step = t.find(s);
    if (step && (!best || step.cost < best.cost)) best = step;
  }
  return best && best.cost <= maxCost ? best : null;
}

export function rate(maxCost: number): Rating {
  if (maxCost >= 10) return 'Fiendish';
  if (maxCost > 4) return 'Expert';
  if (maxCost > 3) return 'Hard';
  if (maxCost > 2.2) return 'Medium';
  return 'Easy';
}

export function logicSolve(ctx: SolveContext, opts: { maxCost?: number; start?: ArrayLike<number> } = {}): SolveTrace {
  const s = createLogicState(ctx, opts.start);
  const steps: Step[] = [];
  let exceeded = false;
  while (!s.placed.every(Boolean)) {
    if (isContradiction(s)) break;
    const step = findNextStep(s, opts.maxCost);
    if (!step) {
      exceeded = opts.maxCost !== undefined && findNextStep(s) !== null;
      break;
    }
    steps.push(step);
    applyStep(s, step);
  }
  const solved = s.placed.every(Boolean) && !isContradiction(s);
  const maxCost = steps.reduce((m, st) => Math.max(m, st.cost), 0);
  const totalCost = steps.reduce((a, st) => a + st.cost, 0);
  const difficulty = Math.round(maxCost * 20 + (totalCost / ctx.topo.cellCount) * 25);
  return { steps, solved, exceeded, maxCost, totalCost, difficulty, rating: rate(maxCost) };
}
