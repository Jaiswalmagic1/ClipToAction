// A way in — the real app, the real Worker, and a COPY of his notebook, on this machine.
//
// Twenty-five review rounds were run against a test harness and a database of fixtures.
// Nobody had ever opened the thing and looked at it. This boots the real Worker over real
// SQLite loaded from a `wrangler d1 export` backup, serves the real `index.html` with its
// sign-in replaced by a fixed account, and lets a browser click through it.
//
// It never talks to the live system. Everything here is local and read from a file.
//
//   node scripts/look-at-it.mjs <backup.sql> [email]
//
// Nothing in this file is shipped: it is a workbench, not a feature.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/worker.js";
import { createTestEnv } from "../test/helpers/testenv.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const backupPath = process.argv[2];
const wantEmail = process.argv[3] || null;
if (!backupPath) {
  console.error("usage: node scripts/look-at-it.mjs <backup.sql> [email]");
  process.exit(1);
}

const harness = await createTestEnv();

// --- load the backup into the local database -------------------------------------------
//
// The export is one statement per line for the INSERTs and multi-line for the CREATEs. The
// schema is already there from the test env, so only the INSERTs are replayed — and each
// one is tried on its own, because a row that will not fit (a table this build does not
// have) must not stop the rest.
// Foreign keys off for the load. The export writes rows in table order, so a clip
// arrives before the reel it points at -- 408 of 433 were refused for that alone.
// The export asks for the same thing on its own first line.
harness.database.exec("PRAGMA foreign_keys = OFF");

const dump = readFileSync(backupPath, "utf8");
const inserts = dump.split("\n").filter((line) => line.startsWith("INSERT INTO "));
let loaded = 0;
let skipped = 0;
for (const line of inserts) {
  try {
    harness.database.exec(line);
    loaded += 1;
  } catch {
    skipped += 1;
  }
}
console.log(`loaded ${loaded} rows from the backup (${skipped} skipped)`);

// --- whose notebook to open -------------------------------------------------------------
const people = harness.database
  .prepare(
    `SELECT u.id, u.email, COUNT(c.id) AS clips
     FROM users u LEFT JOIN clips c ON c.user_id = u.id AND c.deleted_at IS NULL
     GROUP BY u.id ORDER BY clips DESC`
  )
  .all();
console.log("accounts in the backup:");
for (const one of people) console.log(`  ${one.clips.toString().padStart(4)}  ${one.email}`);

const who = wantEmail
  ? people.find((one) => one.email === wantEmail)
  : people[0];
if (!who) {
  console.error(`no account for ${wantEmail}`);
  process.exit(1);
}
console.log(`\nopening as ${who.email} (${who.clips} clips)`);

const token = await harness.mintToken(who.id);

// --- the app, pointed at this machine ----------------------------------------------------
//
// Two changes to the page, and only two: the API address, and the sign-in. Everything else
// — every screen, every button, all the CSS — is the file exactly as it ships.
function pageFor() {
  let html = readFileSync(join(repo, "index.html"), "utf8");
  html = html.replace(
    /const API_BASE = "[^"]*";/,
    'const API_BASE = "";'
  );
  html = html.replace(
    /import \{ initializeApp \} from "[^"]+";/,
    "const initializeApp = () => ({});"
  );
  html = html.replace(
    /import \{[\s\S]*?\} from "https:\/\/www\.gstatic\.com\/firebasejs[^"]+";/,
    `const getAuth = () => ({});
     const GoogleAuthProvider = class {};
     const signInWithPopup = async () => {};
     const signOut = async () => {};
     const onAuthStateChanged = (auth, handler) => {
       setTimeout(() => handler({
         uid: ${JSON.stringify(who.id)},
         email: ${JSON.stringify(who.email)},
         getIdToken: async () => ${JSON.stringify(token)}
       }), 0);
     };`
  );
  return html;
}

const port = Number(process.env.PORT || 8788);
createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pageFor());
    return;
  }

  // Everything else goes to the real Worker, exactly as the browser sent it.
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : await new Promise((done) => {
        let text = "";
        request.on("data", (chunk) => { text += chunk; });
        request.on("end", () => done(text));
      });

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }

  const answer = await worker.fetch(
    new Request(`https://local.test${request.url}`, {
      method: request.method,
      headers,
      body: body || undefined
    }),
    harness.env
  );
  const text = await answer.text();
  const out = {};
  answer.headers.forEach((value, name) => { out[name] = value; });
  response.writeHead(answer.status, out);
  response.end(text);
}).listen(port, () => {
  console.log(`\nopen  http://localhost:${port}\n`);
});
