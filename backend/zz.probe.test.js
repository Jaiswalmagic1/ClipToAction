import { test } from "node:test";
import { createTestEnv } from "./test/helpers/testenv.js";
import worker from "./src/worker.js";

const URL1 = "https://www.youtube.com/watch?v=abcdefghijk";

async function setupLong(h, who, token) {
  const saved = await h.call(worker, "/v1/clips", { method: "POST", token, body: { url: URL1 } });
  return saved.body.clip;
}

test("probe: long_ok_by and cross-user park", async () => {
  const h = await createTestEnv();
  const alice = await h.mintToken("alice");
  const bob = await h.mintToken("bob");

  const aClip = await setupLong(h, "alice", alice);
  const bClip = await setupLong(h, "bob", bob);
  const sourceId = aClip.source_id;
  console.log("same source?", aClip.source_id === bClip.source_id);

  // Worker claims it, reports it too long
  await h.call(worker, "/v1/queue", { serviceToken: h.env.WORKER_SERVICE_TOKEN });
  await h.call(worker, `/v1/sources/${sourceId}/too-long`, {
    method: "POST", serviceToken: h.env.WORKER_SERVICE_TOKEN,
    body: { duration_sec: 3600, title: "A long one", creator: "Someone" }
  });

  // Bob approves it -> long_ok_by = bob
  const ok = await h.call(worker, `/v1/clips/${bClip.id}/long-ok`, { method: "POST", token: bob });
  console.log("bob approve ->", ok.status, JSON.stringify(ok.body));

  // What does Alice see in sync?
  const sync = await h.call(worker, "/v1/sync?since=0", { token: alice });
  console.log("ALICE SEES SOURCE:", JSON.stringify(sync.body.sources[0]));

  // Can a signed-in user reach the service routes?
  const svc1 = await h.call(worker, "/v1/creators", { token: alice });
  console.log("GET /v1/creators as user ->", svc1.status, JSON.stringify(svc1.body));
  const svc2 = await h.call(worker, `/v1/sources/${sourceId}/creator`, {
    method: "POST", token: alice, body: { creator: "hacked" } });
  console.log("POST creator as user ->", svc2.status, JSON.stringify(svc2.body));
  const svc3 = await h.call(worker, `/v1/sources/${sourceId}/too-long`, {
    method: "POST", token: alice, body: { duration_sec: 99999 } });
  console.log("POST too-long as user ->", svc3.status, JSON.stringify(svc3.body));

  // Can the PC worker reach a user route?
  const usr = await h.call(worker, "/v1/sync?since=0", { serviceToken: h.env.WORKER_SERVICE_TOKEN });
  console.log("sync with service token ->", usr.status, JSON.stringify(usr.body));

  // Cross-user park: alice parks a video bob approved
  const parked = await h.call(worker, `/v1/clips/${aClip.id}/long-park`, { method: "POST", token: alice });
  console.log("alice park after bob approved ->", parked.status, JSON.stringify(parked.body));
});
