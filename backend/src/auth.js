// Firebase ID token verification and API-key encryption for the ClipToAction Worker.
//
// Firebase tokens are RS256 JWTs signed by Google. We verify them against Google's
// published JWK set rather than trusting anything the client sends.

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let jwksCache = { keys: null, expiresAt: 0 };

/** Anything the client can fix by signing in again. The router maps this to 401. */
export class AuthError extends Error {}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function getJwks() {
  const now = Date.now();
  if (jwksCache.keys && now < jwksCache.expiresAt) return jwksCache.keys;

  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);

  const body = await response.json();
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") || "");
  jwksCache = {
    keys: body.keys,
    expiresAt: now + (maxAge ? Number(maxAge[1]) * 1000 : 3600_000)
  };
  return jwksCache.keys;
}

/**
 * Verifies a Firebase ID token and returns its claims.
 * Throws on any failure — callers must not fall through to an unauthenticated path.
 */
export async function verifyFirebaseToken(token, projectId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new AuthError("Malformed token");

  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new AuthError("Malformed token");
  }

  if (header.alg !== "RS256") throw new AuthError("Unexpected token algorithm");

  const jwk = (await getJwks()).find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new AuthError("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    signed
  );
  if (!valid) throw new AuthError("Bad token signature");

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) throw new AuthError("Token expired");
  if (claims.iat > now + 60) throw new AuthError("Token issued in the future");
  if (claims.aud !== projectId) throw new AuthError("Token audience mismatch");
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AuthError("Token issuer mismatch");
  }
  if (!claims.sub) throw new AuthError("Token missing subject");

  return claims;
}

async function encryptionKey(secret) {
  const material = base64UrlToBytes(secret);
  // A short secret would silently give AES-192 or AES-128 instead of failing.
  if (material.length !== 32) {
    throw new Error("KEY_ENCRYPTION_SECRET must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Encrypts a user's provider API key. Output is base64(iv || ciphertext). */
export async function encryptSecret(plaintext, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      new TextEncoder().encode(plaintext)
    )
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return bytesToBase64(packed);
}

/** Decrypts a stored provider API key. Only ever called server-side. */
export async function decryptSecret(packedBase64, secret) {
  const packed = base64UrlToBytes(packedBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12) },
    await encryptionKey(secret),
    packed.slice(12)
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Compares the PC worker's service token without leaking *where* it first differs.
 * It does return early on a length mismatch, so the length is observable — that is
 * accepted: the token is high-entropy and knowing its length does not help an attacker.
 */
export function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
