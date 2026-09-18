// @ts-check
// The secret envelope: how the console encrypts a secret to a deployment so the
// relay carrying it never sees the plaintext (#549, decided in #514, map #497).
//
// Plain JS rather than TypeScript because this is the first *runtime* value in
// contracts. Node 24 refuses to type-strip a `.ts` file under a `node_modules`
// segment, so an installed consumer's `import { sealSecret } from
// "phoebe-agent/contracts"` has to land on real JavaScript. The JSDoc below is
// not decoration: index.ts re-exports from this file and TypeScript reads these
// annotations, so consumers still get a typed signature. One implementation, one
// place to change it — the alternative was the same crypto written twice, once
// per condition of the export map, drifting apart the first time either moved.
//
// ECIES assembled from WebCrypto primitives, per #514 §6: ephemeral X25519 to
// the deployment's box key, HKDF-SHA256 to an AES-256-GCM key, random 12-byte
// IV. WebCrypto has no HPKE and no sealed box, and the deployment's dependency
// count is fixed at zero (#506), so the construction is spelled out here. Both
// runtimes have every primitive it uses: Node 24 core and browser WebCrypto.
//
// What it does not promise: the relay serves the JavaScript that seals, so a
// hostile relay can swap that code or the key it hands the browser. The
// guarantee is that the relay never *holds* a secret — not in storage, not in
// logs, not in a memory dump, not in a passive compromise (#514 §4).

/** Wire version. An envelope whose `v` is anything else is refused, not guessed at. */
const ENVELOPE_VERSION = 1;

/**
 * HKDF `info`. Domain-separates this key from anything else that might one day
 * derive from the same ECDH secret; moves only alongside `ENVELOPE_VERSION`.
 */
const HKDF_INFO = "phoebe secret v1";

/** AES-GCM wants a 96-bit IV. */
const IV_BYTES = 12;

/**
 * The separator between AAD fields. See `encodeAad` for why it is NUL and why a
 * field containing one is refused.
 */
const AAD_SEPARATOR = "\u0000";

/**
 * The AAD fields in the order #514 §6 fixes them:
 * `keyFingerprint ‖ tenant ‖ key ‖ editId`. Binding all four is what stops an
 * envelope being replayed at another deployment, another tenant, another key
 * name, or another entry in the edit ledger.
 *
 * @type {readonly ["keyFingerprint", "tenant", "key", "editId"]}
 */
const AAD_FIELDS = ["keyFingerprint", "tenant", "key", "editId"];

/**
 * A sealed secret as it travels: console → relay → deployment. Every field is
 * base64url without padding. The relay stores and forwards this and can read
 * none of it.
 *
 * @typedef {object} SecretEnvelope
 * @property {1} v The wire version.
 * @property {string} epk The ephemeral X25519 public key, raw, 32 bytes.
 * @property {string} iv The AES-GCM initialisation vector, 12 bytes.
 * @property {string} ct The ciphertext with its GCM tag appended.
 */

/**
 * What an envelope is bound to. All four must match at open time or the secret
 * stays shut — this is the replay defence, not a convenience.
 *
 * @typedef {object} EnvelopeAad
 * @property {string} keyFingerprint The deployment key fingerprint (#514 §8).
 * @property {string} tenant The tenant the secret belongs to.
 * @property {string} key The secret's name in the store.
 * @property {string} editId The ledger entry this edit is.
 */

/**
 * @typedef {object} SealRequest
 * @property {string} boxKey The deployment's X25519 public key: raw, base64url — the form `hello` and `links.json` carry.
 * @property {EnvelopeAad} aad What to bind the envelope to.
 * @property {string} plaintext The secret.
 */

/**
 * @typedef {object} OpenRequest
 * @property {Uint8Array} boxPrivateKey The deployment's X25519 private key in PKCS8 DER — the body of the `box` PEM in `state/relay-key`, unarmoured.
 * @property {EnvelopeAad} aad What the envelope must have been bound to.
 * @property {SecretEnvelope} envelope The envelope as received.
 */

/**
 * WebCrypto's key type, named without a `lib` contracts cannot have: no DOM lib
 * is configured and `node:crypto` is off limits here, so the type is read off
 * the global class instead. Same for the key pair, which `generateKey` returns
 * for X25519 but is not typed as returning.
 *
 * @typedef {InstanceType<typeof CryptoKey>} WebCryptoKey
 * @typedef {{ privateKey: WebCryptoKey, publicKey: WebCryptoKey }} WebCryptoKeyPair
 */

/**
 * Join the AAD fields into bytes.
 *
 * NUL separates them and a NUL inside a field is refused, which together make
 * the join injective. Without that, `{tenant: "ab", key: "c"}` and
 * `{tenant: "a", key: "bc"}` would encode identically and an envelope sealed for
 * one would open under the other — the field boundaries would stop binding
 * anything. Every value here is an identifier or a hex fingerprint, so nothing
 * legitimate is being turned away.
 *
 * @param {EnvelopeAad} aad
 * @returns {Uint8Array<ArrayBuffer>}
 */
function encodeAad(aad) {
  if (aad === null || typeof aad !== "object") {
    throw new Error("secret envelope: the AAD is missing");
  }
  const parts = AAD_FIELDS.map((field) => {
    const value = /** @type {Record<string, unknown>} */ (aad)[field];
    if (typeof value !== "string") {
      throw new Error(`secret envelope: AAD field "${field}" must be a string`);
    }
    if (value.includes(AAD_SEPARATOR)) {
      throw new Error(`secret envelope: AAD field "${field}" must not contain a NUL`);
    }
    return value;
  });
  return new TextEncoder().encode(parts.join(AAD_SEPARATOR));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The buffer is named in the return type for the same reason the box key's is:
 * a browser's `BufferSource` will not take a view that might sit over a
 * `SharedArrayBuffer`, and every one of these goes straight into WebCrypto.
 *
 * @param {unknown} text
 * @param {string} what The field name, so a malformed envelope says which part.
 * @returns {Uint8Array<ArrayBuffer>}
 */
function fromBase64Url(text, what) {
  if (typeof text !== "string") {
    throw new Error(`secret envelope: "${what}" is missing`);
  }
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary;
  try {
    binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  } catch {
    throw new Error(`secret envelope: "${what}" is not base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * ECDH to a shared secret, then HKDF-SHA256 to the AES key. Both directions run
 * this: sealing derives from the ephemeral private key and the box key, opening
 * from the box private key and the ephemeral public key, and X25519 makes the
 * two agree.
 *
 * @param {WebCryptoKey} privateKey
 * @param {WebCryptoKey} publicKey
 * @param {"encrypt" | "decrypt"} usage
 * @returns {Promise<WebCryptoKey>}
 */
async function deriveContentKey(privateKey, publicKey, usage) {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * @param {string} boxKey
 * @returns {Promise<WebCryptoKey>}
 */
async function importBoxKey(boxKey) {
  const raw = fromBase64Url(boxKey, "boxKey");
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
  } catch {
    throw new Error("secret envelope: the box key is not a raw X25519 public key");
  }
}

/**
 * The per-envelope ephemeral pair. Wrapped because `generateKey` is typed as
 * returning a single key: the lib does not know X25519 is a key-agreement
 * algorithm, so the cast is the whole reason this function exists.
 *
 * @returns {Promise<WebCryptoKeyPair>}
 */
async function generateEphemeralPair() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  return /** @type {WebCryptoKeyPair} */ (/** @type {unknown} */ (pair));
}

/**
 * Seal a secret to a deployment's box key. Runs in the browser, in the console's
 * secrets form: nothing leaves the page but the envelope.
 *
 * Every call generates a fresh ephemeral key and a fresh IV, so sealing the same
 * secret twice gives two unrelated envelopes.
 *
 * @param {SealRequest} request
 * @returns {Promise<SecretEnvelope>}
 */
export async function sealSecret({ boxKey, aad, plaintext }) {
  if (typeof plaintext !== "string") {
    throw new Error("secret envelope: the plaintext must be a string");
  }
  const additionalData = encodeAad(aad);
  const recipient = await importBoxKey(boxKey);
  const ephemeral = await generateEphemeralPair();
  const contentKey = await deriveContentKey(ephemeral.privateKey, recipient, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    contentKey,
    new TextEncoder().encode(plaintext),
  );
  const epk = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return {
    v: ENVELOPE_VERSION,
    epk: toBase64Url(new Uint8Array(epk)),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Open an envelope. Runs on the deployment, the only holder of the box private
 * key.
 *
 * Throws when the envelope is malformed, when its version is one this build does
 * not know, and — the case that matters — when it was sealed for a different
 * deployment, tenant, key or edit. GCM cannot tell those four apart from a
 * tampered ciphertext, and neither does the message: every one of them means the
 * bytes are not a secret meant for here.
 *
 * @param {OpenRequest} request
 * @returns {Promise<string>} The plaintext.
 */
export async function openSecret({ boxPrivateKey, aad, envelope }) {
  if (envelope === null || typeof envelope !== "object") {
    throw new Error("secret envelope: the envelope is missing");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`secret envelope: unsupported version ${String(envelope.v)}`);
  }
  if (!(boxPrivateKey instanceof Uint8Array)) {
    throw new Error("secret envelope: the box private key must be PKCS8 bytes");
  }
  const additionalData = encodeAad(aad);
  const iv = fromBase64Url(envelope.iv, "iv");
  const ciphertext = fromBase64Url(envelope.ct, "ct");
  let recipient;
  try {
    // Copied into a buffer of its own, which is not ceremony: a caller's
    // `Uint8Array` may sit over a `SharedArrayBuffer` as far as a browser's
    // types are concerned, and WebCrypto will not take one. Forty-eight bytes.
    recipient = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(boxPrivateKey),
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
  } catch {
    throw new Error("secret envelope: the box private key is not an X25519 key in PKCS8");
  }
  // Decoded outside the catch so a base64url complaint is not overwritten by
  // the curve one — the two say different things about a malformed envelope.
  const epk = fromBase64Url(envelope.epk, "epk");
  let ephemeral;
  try {
    ephemeral = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
  } catch {
    throw new Error('secret envelope: "epk" is not a raw X25519 public key');
  }
  const contentKey = await deriveContentKey(recipient, ephemeral, "decrypt");
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      contentKey,
      ciphertext,
    );
  } catch {
    throw new Error(
      "secret envelope: this envelope was not sealed for this deployment, tenant, key and edit",
    );
  }
  return new TextDecoder().decode(plaintext);
}
