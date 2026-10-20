// Prime factorisation text for × cages (shown on a long-press).

/** "24× = 2 × 2 × 2 × 3 = 2³ × 3" (the powers part only when a prime repeats). */
export function primeFactorText(target: number): string {
  if (!Number.isInteger(target) || target < 2) return `${target}×`;
  const primes: number[] = [];
  let m = target;
  for (let p = 2; p * p <= m; p++) while (m % p === 0) primes.push(p), (m /= p);
  if (m > 1) primes.push(m);
  if (primes.length === 1) return `${target}× is prime`;
  const sup = (k: number) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
  const counts = [...new Set(primes)].map((p) => [p, primes.filter((q) => q === p).length]);
  const powers = counts.map(([p, k]) => (k > 1 ? `${p}${sup(k)}` : `${p}`)).join(' × ');
  const flat = primes.join(' × ');
  return counts.some(([, k]) => k > 1) ? `${target}× = ${flat} = ${powers}` : `${target}× = ${flat}`;
}
