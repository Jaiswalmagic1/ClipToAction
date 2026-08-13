// Test harness for the Worker: a real SQLite database behind a D1-shaped adapter, and
// real RS256 tokens signed by a key pair we generate here and serve as Google's JWK set.
//
// Nothing is stubbed inside the Worker itself. `verifyFirebaseToken` runs its actual
// signature check against our public key, so these tests exercise the true auth path —
// including the cases that must FAIL, which a mocked-out verifier could never prove.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, "..", "..", "schema.sql"), "utf8");

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export const PROJECT_ID = "cliptoaction-test";
const KID = "test-key-1";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** Minimal D1 shim over node:sqlite. Same call shape the Worker uses. */
function d1(database) {
  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) {
          params = values.map((value) => (value === undefined ? null : value));
          return statement;
        },
        async first() {
          return database.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: database.prepare(sql).all(...params) };
        },
        async run() {
          const result = database.prepare(sql).run(...params);
          return { meta: { changes: Number(result.changes) } };
        }
      };
      return statement;
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    }
  };
}

/**
 * Builds an isolated environment: fresh database, fresh signing key, fetch stubbed to
 * serve the matching JWK set. Returns helpers for minting tokens and calling the Worker.
 */
export async function createTestEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(SCHEMA);

  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };

  const realFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === JWKS_URL) {
      return new Response(JSON.stringify(jwks), {
        headers: { "Content-Type": "application/json", "cache-control": "max-age=3600" }
      });
    }
    // Any AI provider call in a test is recorded and refused, so no test can reach the
    // network and a leaked key would be visible here.
    providerCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({ error: "blocked in tests" }), { status: 503 });
  };

  async function mintToken(sub, overrides = {}) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", kid: KID, typ: "JWT", ...(overrides.header || {}) };
    const claims = {
      sub,
      email: `${sub}@example.com`,
      aud: PROJECT_ID,
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      iat: issuedAt,
      exp: issuedAt + 3600,
      ...overrides
    };
    delete claims.header;

    const signingInput =
      `${base64url(Buffer.from(JSON.stringify(header)))}.` +
      `${base64url(Buffer.from(JSON.stringify(claims)))}`;

    const signature = overrides.forgeSignature
      ? new Uint8Array(256)
      : new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keyPair.privateKey,
            new TextEncoder().encode(signingInput)
          )
        );

    return `${signingInput}.${base64url(signature)}`;
  }

  const env = {
    DB: d1(database),
    FIREBASE_PROJECT_ID: PROJECT_ID,
    WORKER_SERVICE_TOKEN: "service-token-for-tests",
    KEY_ENCRYPTION_SECRET: base64url(Buffer.alloc(32, 7)),
    APP_ORIGIN: "https://example.test"
  };

  return {
    env,
    database,
    providerCalls,
    mintToken,

    /** Calls the Worker the way Cloudflare would. */
    async call(worker, path, { method = "GET", token, serviceToken, body } = {}) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (serviceToken) headers["X-Service-Token"] = serviceToken;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const response = await worker.fetch(
        new Request(`https://api.test${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        }),
        env
      );

      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null
      };
    },

    restore() {
      globalThis.fetch = realFetch;
      database.close();
    }
  };
}
