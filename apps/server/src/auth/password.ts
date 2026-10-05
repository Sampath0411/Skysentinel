/**
 * Password hashing (PRD §17 security).
 *
 * scrypt from Node's own crypto, with a per-password salt. No dependency, no
 * native build, and it is the algorithm the reference implementation and every
 * current language runtime ships — which matters here because the tool is offline
 * and must work identically on a machine with no package registry.
 *
 * argon2id would be the better primitive, but it needs a native module, and the
 * PRD's threat model is a local file on a laptop: the realistic attack is someone
 * copying the database, and a salted scrypt digest is what stands between that
 * file and a password list. `scrypt`'s parameters below are the Node defaults,
 * which are ~64 MB and ~100 ms per hash — deliberate, and slow enough to matter.
 */

import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

// `promisify` picks the 3-argument overload, so the cost options are dropped from
// the type even though `scrypt` accepts them at runtime. Wrapping by hand keeps the
// options typed — and the options are the whole point of storing N/r/p in the hash.
interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  maxmem?: number;
}

const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key as Buffer),
    );
  });

/** Cost parameters. Stored in the hash so they can be raised without a migration. */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hash a password as `scrypt$N$r$p$salt$key`, all base64url.
 *
 * The parameters travel inside the string so verification reads them back rather
 * than assuming the current constants — otherwise raising the cost would lock
 * every existing user out.
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const opts = { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, opts);

  return [
    "scrypt",
    opts.N,
    opts.r,
    opts.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
};

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row is a
 * failed login, not a 500 that tells an attacker which usernames exist.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }

  const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });

  // Constant-time: a length or early-exit difference would leak the digest.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/**
 * Whether a stored password is still on the cheap parameters.
 *
 * Checked at login so passwords re-hash themselves on next use rather than
 * needing a forced reset when the cost is raised.
 */
export const needsRehash = (stored: string): boolean => {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) !== 16384 || Number(parts[2]) !== 8 || Number(parts[3]) !== 1;
};
