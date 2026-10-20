// Puzzle generation off the main thread so effects never stutter.
import { generatePuzzle, type GenOptions } from './generator';

self.onmessage = (e: MessageEvent<GenOptions>) => {
  try {
    self.postMessage({ ok: true, ...generatePuzzle(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
