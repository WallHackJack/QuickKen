import { expect, it } from 'vitest';
import { primeFactorText } from '../src/game/factor';

it('factorises × cage targets', () => {
  expect(primeFactorText(24)).toBe('24× = 2 × 2 × 2 × 3 = 2³ × 3');
  expect(primeFactorText(30)).toBe('30× = 2 × 3 × 5');
  expect(primeFactorText(7)).toBe('7× is prime');
  expect(primeFactorText(144)).toBe('144× = 2 × 2 × 2 × 2 × 3 × 3 = 2⁴ × 3²');
});
