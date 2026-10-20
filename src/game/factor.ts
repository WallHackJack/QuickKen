// Prime factorisation of a × cage's target (shown on a long-press), e.g. 24 → "2³ × 3".

/** The prime factorisation in powers form ("2³ × 3"), or null for a prime (or anything below 2). */
export function primeFactors(target: number): string | null {
  if (!Number.isInteger(target) || target < 2) return null;
  const primes: number[] = [];
  let m = target;
  for (let p = 2; p * p <= m; p++) while (m % p === 0) primes.push(p), (m /= p);
  if (m > 1) primes.push(m);
  if (primes.length === 1) return null;
  const sup = (k: number) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
  return [...new Set(primes)].map((p) => {
    const k = primes.filter((q) => q === p).length;
    return k > 1 ? `${p}${sup(k)}` : `${p}`;
  }).join(' × ');
}
