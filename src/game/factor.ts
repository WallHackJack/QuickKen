// Prime factorisation of a × cage's target (shown on a long-press), e.g. 24 → "2³ × 3".

const sup = (k: number) => String(k).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const isPrime = (n: number) => {
  for (let p = 2; p * p <= n; p++) if (n % p === 0) return false;
  return n > 1;
};

/** The prime factorisation in powers form ("2³ × 3"), or null for a prime (or anything below 2). */
export function primeFactors(target: number): string | null {
  if (!Number.isInteger(target) || target < 2) return null;
  const primes: number[] = [];
  let m = target;
  for (let p = 2; p * p <= m; p++) while (m % p === 0) primes.push(p), (m /= p);
  if (m > 1) primes.push(m);
  if (primes.length === 1) return null;
  return [...new Set(primes)].map((p) => {
    const k = primes.filter((q) => q === p).length;
    return k > 1 ? `${p}${sup(k)}` : `${p}`;
  }).join(' × ');
}

/**
 * Factor a × cage's target (taken as positive) in terms the digit set can use. When every digit is a
 * multiple of one composite number (10s mode: 10, 20, … 60), each of the cage's \`cells\` digits brings
 * that factor once, so it comes out as a power first and only the rest is broken into primes:
 * 6000 over 3 cells → "10³ × 2 × 3" (digits 10·a, 10·b, 10·c with a·b·c = 6), never 2s and 5s.
 * Otherwise it's the plain prime factorisation. Null when there's nothing to split (a prime).
 */
export function cageFactors(target: number, digits: number[], cells: number): string | null {
  const t = Math.abs(target);
  const g = digits.map((v) => Math.abs(Math.round(v))).reduce(gcd, 0);
  if (Number.isInteger(t) && g > 1 && !isPrime(g) && t % g ** cells === 0) {
    const rest = t / g ** cells;
    const head = cells > 1 ? `${g}${sup(cells)}` : `${g}`;
    if (rest === 1) return head;
    return `${head} × ${primeFactors(rest) ?? rest}`;
  }
  return primeFactors(t);
}
