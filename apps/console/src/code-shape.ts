// The shape of a pairing code as typed (map #690, #695): twelve Crockford
// characters, forgiving of case, dashes, spaces and the four look-alikes. The
// deployment normalises the same way before it hashes; this is only so a code
// with the wrong number of characters is refused here, where the person can
// still see what they typed.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The code as the deployment reads it, or null when it is not twelve of the alphabet. */
export function normalizeCodeShape(input: string): string | null {
  const stripped = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (stripped.length !== 12) return null;
  for (const char of stripped) if (!ALPHABET.includes(char)) return null;
  return stripped;
}

/** `XXXX-XXXX-XXXX`, the shape a person reads. */
export function formatCodeShape(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}
