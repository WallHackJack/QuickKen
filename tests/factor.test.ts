import { expect, it } from 'vitest';
import { primeFactors } from '../src/game/factor';

it('factorises × cage targets in powers form', () => {
  expect(primeFactors(24)).toBe('2³ × 3');
  expect(primeFactors(30)).toBe('2 × 3 × 5');
  expect(primeFactors(144)).toBe('2⁴ × 3²');
  expect(primeFactors(7)).toBeNull();
});
