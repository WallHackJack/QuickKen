// Cage operators are plain objects in a registry. All cage reasoning goes through evaluate(),
// so a new operator needs nothing else to work with the solver, generator, hints and difficulty.

export interface OperatorDef {
  id: string;
  /** Shown after the target, e.g. "12+" */
  symbol: string;
  name: string;
  minCells: number;
  maxCells: number;
  /** Result of the cage for these values (in cell order), or null if undefined (e.g. ÷0). */
  evaluate(values: number[]): number | null;
  /** Relative mental effort of checking a combination; feeds difficulty. */
  effort: number;
}

const EPS = 1e-9;
export const approxEq = (a: number, b: number): boolean => Math.abs(a - b) < EPS * Math.max(1, Math.abs(a), Math.abs(b));

const registry = new Map<string, OperatorDef>();

export function registerOperator(op: OperatorDef): void {
  registry.set(op.id, op);
}

export function getOperator(id: string): OperatorDef {
  const op = registry.get(id);
  if (!op) throw new Error(`Unknown operator "${id}"`);
  return op;
}

export const allOperators = (): OperatorDef[] => [...registry.values()];

/** For 2-cell ops: the larger-magnitude value first. */
const byMagnitude = (v: number[]): [number, number] => (Math.abs(v[0]) >= Math.abs(v[1]) ? [v[0], v[1]] : [v[1], v[0]]);

registerOperator({ id: 'given', symbol: '', name: 'Given', minCells: 1, maxCells: 1, effort: 0, evaluate: (v) => v[0] });
// Campaign: a lone cell with no clue, labelled "?" (any digit fits; its target is 0 and so is its result).
registerOperator({ id: 'unknown', symbol: '?', name: 'Unknown', minCells: 1, maxCells: 1, effort: 0, evaluate: () => 0 });
registerOperator({ id: 'add', symbol: '+', name: 'Sum', minCells: 2, maxCells: Infinity, effort: 1, evaluate: (v) => v.reduce((a, b) => a + b, 0) });
registerOperator({ id: 'mul', symbol: '×', name: 'Product', minCells: 2, maxCells: Infinity, effort: 1.2, evaluate: (v) => v.reduce((a, b) => a * b, 1) });
registerOperator({ id: 'sub', symbol: '−', name: 'Difference', minCells: 2, maxCells: 2, effort: 0.8, evaluate: (v) => Math.abs(v[0] - v[1]) });
registerOperator({
  id: 'div', symbol: '÷', name: 'Quotient', minCells: 2, maxCells: 2, effort: 0.9,
  evaluate: (v) => {
    const [a, b] = byMagnitude(v);
    return b === 0 ? null : a / b;
  },
});
// --- New operators ---
registerOperator({ id: 'max', symbol: '↑', name: 'Maximum', minCells: 2, maxCells: Infinity, effort: 0.7, evaluate: (v) => Math.max(...v) });
registerOperator({ id: 'min', symbol: '↓', name: 'Minimum', minCells: 2, maxCells: Infinity, effort: 0.7, evaluate: (v) => Math.min(...v) });
registerOperator({ id: 'range', symbol: 'Δ', name: 'Range', minCells: 3, maxCells: Infinity, effort: 1.1, evaluate: (v) => Math.max(...v) - Math.min(...v) });
registerOperator({
  id: 'mod', symbol: '%', name: 'Remainder', minCells: 2, maxCells: 2, effort: 1.3,
  evaluate: (v) => {
    const [a, b] = byMagnitude(v.map(Math.abs));
    return b === 0 ? null : a % b;
  },
});
