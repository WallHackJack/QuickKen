# QuickKen

A fast, flashy KenKen-style number puzzle that runs in the browser. Chain reactions fill cells for you,
drag across cells to fill maybes, spot pairs and see cage sums, and try ideas in coloured guess layers
you can confirm or undo.

**Play:** https://wallhackjack.github.io/QuickKen/

## Develop

```bash
npm install
npm run dev
```

Tests: `npx vitest run`. Every push to `main` builds the game and publishes it to GitHub Pages
(see `.github/workflows/pages.yml`).

- `src/engine/` puzzle model, generator and solver
- `src/game/` game state, undo history, guesses, saving
- `src/render/` board rendering, lighting and effects (PixiJS)
- `src/ui/` buttons, options and dialogs
- `puzzles/` saved puzzle definitions
