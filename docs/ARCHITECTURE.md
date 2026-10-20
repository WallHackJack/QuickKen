# KenKen Game — Architecture

Stack: **TypeScript + Vite**, **PixiJS v8** (WebGL/WebGPU) for the board and VFX, DOM for menus/dialogue,
**Capacitor** later to package Android/iOS. Original code only — MathDoku (GPL) is reference material, not a source.

```
src/
  engine/    Pure TS. No DOM, no Pixi. Runs in a Web Worker and in unit tests.
    bits.ts        candidate bitmasks
    digits.ts      custom digit sets
    operators.ts   pluggable cage operators (registry)
    puzzle.ts      puzzle model + topology (houses, peers, cages)
    rng.ts         seeded RNG (daily/weekly challenges are a seed)
    tuples.ts      cage tuple enumeration — the core of all cage reasoning
    propagate.ts   fast constraint propagation
    backtrack.ts   solution counter (uniqueness check)
    techniques.ts  human-style deduction rules, each with a cost
    logic.ts       step-by-step logical solver → trace → difficulty
    generator.ts   seeded puzzle generator
  game/      Game state: values, maybes, history, guess layers, auto-fill chains
  render/    Pixi: board, one container per cage, particles, shaders, tweens
  ui/        DOM toolbar / panels
```

## Design decisions per feature

### Custom digit sets
A puzzle has `size` N and a `DigitSet` of N distinct numbers plus display labels
(`[1..6]`, `[0..5]`, `[2,4,6,8]`, `[-3..3]`, primes, anything). Internally every cell stores a
**digit index** 0..N-1, and candidates are bitmasks over indices, so the solver never cares what the
numbers are. Operators see real values. Labels let a level show symbols that differ from the math values.

### Cage operators
`OperatorDef { id, symbol, minCells, maxCells, evaluate(values) → number | null }`, kept in a registry.
New operators are one object; levels can register their own. All cage reasoning goes through
**tuple enumeration** (every assignment of the cage's cells consistent with candidates and Latin rules
inside the cage), so the solver, generator, hints and difficulty all work for any new operator automatically.
Shipped: `+ − × ÷ =` plus `min max range mod` as examples of new ones.

### Solver ruleset (hints, difficulty, grading)
Two solvers:
- **Backtracker** (`backtrack.ts`): fast, only proves there is exactly one solution.
- **Logic solver** (`logic.ts`): applies the *cheapest applicable* technique one step at a time and records
  a trace. Every step has its technique, its eliminations and placements, the cells/cages/houses that justify it,
  and an explanation.

Techniques (cheapest first): single propagation, given, hidden single, cage combinations, naked subsets,
cage→house pointing, house→cage claiming, hidden subsets, and **trial** (contradiction by bifurcation =
"needs a guess"). More can be added without touching the rest: house sum/product rules (innies/outies), cage-pair
interactions, X-wing style fish, etc.

- **Difficulty** = function of the trace (hardest technique used plus total cost), so the rating measures
  the reasoning a person actually needs.
- **Hints** = run the logic solver from the player's current position and present the next step,
  highlighting its focus cells. A wrong value is caught first ("something in this row is wrong").
- **Grading** (next phase): for each player action, find the cheapest technique that justifies it at that
  moment. That labels it a logical move, a lucky guess, or an error, and can feed scoring and the power bar.

### Auto-fill chain reaction
Only triggers when a cell's maybes are *reduced* to one (adding a first maybe never fills).
A placement removes that digit from peers' maybes, which can reduce more cells to one. The game resolves this
breadth-first into **waves**; the renderer plays each wave with a delay and escalating VFX (combo counter).
The whole chain is one history entry, so a single undo reverts it.

### Guess layers
History is a list of commands, and each change records the layer it was made in. "Guess" pushes a layer (a new ink
colour). Everything entered after that, including auto-fill chains, carries the layer's colour. **Drop guess** reverts
every command back to the guess marker at once; **Keep guess** merges the layer into its parent. Layers nest.

### Timers and power bar
Planned as per-level `rules` modifiers: time limit or par time, power gained per *logical* move (from grading),
and spent on cheats: reveal cell, check errors, auto-fill maybes, show hint, remove a wrong candidate.

### Campaign and dialogue
Levels are data (JSON): digit set, size, hand-made or generated cages (generator with constraints and seed),
rules, and dialogue nodes. Candidate dialogue runtime: Ink (inkjs). The DOM overlay handles text and the
Pixi board stays the stage.

### Daily/weekly challenges and leaderboards
The generator is deterministic for a seed, so a daily puzzle = `seed(hash("daily-2026-10-19"))`. It needs no server
to distribute. Leaderboards need a backend: Supabase or Firebase, or Game Center/Play Games through Capacitor plugins.
The server re-validates the submitted solution and a compact move log (plausible time, no instant solve).

### Rendering: each cage is a unit
Every cage is a Pixi `Container` with its pivot at the cage's centroid. It holds its own background and inset
outline (traced from the union of its cells), its label, and its cells' digits and maybes. Children sit at grid
coordinates relative to the cage, so the cage stays grid-aligned but can scale, wobble, glow, take a filter or
shader, or emit particles as one object. Particles run in a single `ParticleContainer` (GPU-batched, additive blend).
The background is a full-screen fragment shader.

### Mobile packaging
`npx cap add android` / `ios` once features settle. Android builds on Windows (Android Studio).
iOS needs a Mac or a cloud builder (Codemagic, Ionic Appflow).
