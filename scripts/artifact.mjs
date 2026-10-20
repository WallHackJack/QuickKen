// Writes artifact/quickken.html, the page published as a claude.ai Artifact, from the latest build.
// Run via `npm run artifact` (it builds with a relative base first). The Artifact host supplies the
// document skeleton, so this is just the game's title, styles, markup and script.
import fs from 'node:fs';

const html = fs.readFileSync('dist/index.html', 'utf8');
const js = html.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/)?.[1];
const css = html.match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/)?.[1];
if (!js || !css) throw new Error('Could not find the built script and stylesheet in dist/index.html');

fs.mkdirSync('artifact', { recursive: true });
fs.writeFileSync('artifact/quickken.html', `<title>QuickKen</title>
<link rel="stylesheet" href="${css}">
<style>
  /* Single dark look on purpose (neon puzzle board); colours come from the game's own tokens. */
  :root { color-scheme: dark; background: #05060f; }
  html, body { height: 100%; background: #05060f; }
  /* The host already pads :root by the safe-area insets, so the app fills what's left. */
  #app { height: 100%; padding: 0; }
</style>
<div id="app">
  <div id="stage"></div>
  <div id="hud"></div>
</div>
<script type="module" src="${js}"></script>
`);
console.log(`artifact/quickken.html -> ${js}, ${css}`);
