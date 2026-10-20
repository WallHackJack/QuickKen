import { expect, it } from 'vitest';
import { cageFactors, primeFactors } from '../src/game/factor';

it('factorises × cage targets in powers form', () => {
  expect(primeFactors(24)).toBe('2³ × 3');
  expect(primeFactors(30)).toBe('2 × 3 × 5');
  expect(primeFactors(144)).toBe('2⁴ × 3²');
  expect(primeFactors(7)).toBeNull();
});

it('factors out a shared composite step (10s mode) before going to primes', () => {
  const tens = [10, 20, 30, 40, 50, 60];
  expect(cageFactors(6000, tens, 3)).toBe('10³ × 2 × 3');
  expect(cageFactors(1200, tens, 2)).toBe('10² × 2² × 3');
  expect(cageFactors(300, tens, 2)).toBe('10² × 3');
  expect(cageFactors(100, tens, 2)).toBe('10²');
  // Ordinary digits keep plain primes; so do evens (their step, 2, is prime).
  expect(cageFactors(24, [1, 2, 3, 4, 5, 6], 3)).toBe('2³ × 3');
  expect(cageFactors(48, [2, 4, 6, 8], 3)).toBe('2⁴ × 3');
});
