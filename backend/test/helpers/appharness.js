// Runs the real app — the module script inside index.html — in Node, against a real-shaped
// sync response.
//
// Why this exists. Everything the app draws is built by hand out of `document.createElement`,
// and none of it had a single test. That was survivable while the app was one list; it is
// not survivable now that Home reads seven different shapes out of the notebook and decides
// what to say about each. A property renamed in the Worker, or a helper called before it is
// defined, would have reached his phone.
//
// Nothing in `index.html` is changed or stubbed to make this work, and there is no test hook
// in the shipped app. The two Firebase imports are swapped for stand-ins on the way through
// — they are network modules and cannot load here — and `fetch` is answered with a sync
// payload the test writes. Everything else is the app's own code running.
//
// The DOM shim below is deliberately small and dumb. It is not a browser and does not try to
// be: it holds a tree, some text and some handlers, which is all the app uses.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get set() {
    return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean));
  }
  write(set) {
    this.element.className = [...set].join(" ");
  }
  add(...names) {
    const set = this.set;
    for (const name of names) set.add(name);
    this.write(set);
  }
  remove(...names) {
    const set = this.set;
    for (const name of names) set.delete(name);
    this.write(set);
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

class FakeNode {
  constructor(tag) {
    this.tag = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.value = "";
    this.classList = new FakeClassList(this);
    this._text = "";
  }

  get textContent() {
    // The node's OWN text comes first, then its children's. Dropping it once anything was
    // appended is another way this stand-in was different from a browser: the settings
    // screen sets a key's label and then appends to the same element, so a browser reads
    // "mine · working" and this read " · working" — the label gone, and any test about it
    // unwritable. Deleting the label from the app entirely left every test green.
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  set innerHTML(value) {
    // The app only ever clears with this. Anything else would be a real bug in the app,
    // and failing loudly here is the point.
    if (String(value) !== "") throw new Error("the app set innerHTML to markup");
    this.children = [];
    this._text = "";
  }

  get innerHTML() {
    return this.textContent;
  }

  append(...nodes) {
    for (const node of nodes) {
      // A real `append` does NOT skip a null. `ParentNode.append` converts anything that
      // is not a node to a string and inserts a text node — so `append(maybeNothing())`
      // puts the literal word "null" on the page. This harness quietly skipped them, and
      // that is exactly how the word "null" reached his home screen with 543 tests green.
      //
      // Being kinder than the browser is the one thing a stand-in must never be.
      if (node && typeof node === "object") {
        node.parentNode = this;
        this.children.push(node);
        continue;
      }
      const text = new FakeNode("#text");
      text.textContent = String(node);
      text.parentNode = this;
      this.children.push(text);
    }
  }

  prepend(...nodes) {
    // Same rule as `append`: a browser inserts a text node for anything that is not one,
    // rather than throwing. Asymmetry here is how the next null slips through.
    for (const node of nodes.reverse()) {
      if (node && typeof node === "object") {
        node.parentNode = this;
        this.children.unshift(node);
        continue;
      }
      const text = new FakeNode("#text");
      text.textContent = String(node);
      text.parentNode = this;
      this.children.unshift(text);
    }
  }

  scrollIntoView() {}

  closest(selector) {
    const tag = selector.replace(/[^a-z]/gi, "").toLowerCase();
    let node = this;
    while (node) {
      if (node.tag === tag) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** Every node under this one, this one included. For assertions only. */
  walk() {
    return [this, ...this.children.flatMap((child) => child.walk())];
  }

  /** Every node whose class list holds `name`. For assertions only. */
  byClass(name) {
    return this.walk().filter((node) => node.classList.contains(name));
  }
}

/**
 * The buttons that are written into index.html rather than built by the app: the two tabs,
 * the status chips and the view chips. The app reads their `data-` attributes to decide
 * what was pressed, so a harness without them cannot press anything.
 *
 * Read out of the real markup rather than listed here, so adding a view to the page adds
 * it to the harness too.
 */
function seedFromMarkup(html, byId) {
  const containers = /<div [^>]*id="(tabs|filters|views)"[^>]*>([\s\S]*?)<\/div>/g;
  for (const [, id, inner] of html.matchAll(containers)) {
    const holder = new FakeNode("div");
    holder.id = id;
    for (const [, attrs, label] of inner.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)) {
      const button = new FakeNode("button");
      button.textContent = label.trim();
      for (const [, name, value] of attrs.matchAll(/data-([a-z]+)="([^"]*)"/g)) {
        button.dataset[name] = value;
      }
      const className = /class="([^"]*)"/.exec(attrs);
      if (className) button.className = className[1];
      holder.append(button);
    }
    byId.set(id, holder);
  }
}

function makeDocument() {
  const byId = new Map();
  return {
    _seed: (html) => seedFromMarkup(html, byId),
    hidden: false,
    documentElement: new FakeNode("html"),
    body: new FakeNode("body"),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const node = new FakeNode("#text");
      node.textContent = text;
      return node;
    },
    createRange: () => ({ selectNodeContents() {} }),
    // Recorded, not thrown away. A no-op here meant `visibilitychange` — which is how a
    // phone tells the app it has come back — could not be fired by any test, so the one
    // event that happens more than any other on the device he actually uses had never once
    // been executed. `documentListeners` is filled in by createEnv; `fire` reaches both.
    addEventListener(name, handler) {
      if (this.listeners) this.listeners.push([name, handler]);
    },
    listeners: null,
    // Where the page before this one was. The app uses it to tell its OWN share target's
    // fallback from a link somebody pasted.
    referrer: "",
    // Every id the app asks for exists, because in the real page every one of them does.
    // A typo would otherwise read as "this element is missing" rather than failing.
    getElementById(id) {
      if (!byId.has(id)) {
        const node = new FakeNode("div");
        node.id = id;
        byId.set(id, node);
      }
      return byId.get(id);
    },
    _ids: byId
  };
}

/**
 * Loads the app with `sync` as the answer to every sync request, signs a fake person in,
 * and returns the document so a test can read what was drawn.
 */
export async function loadApp(
  sync,
  {
    hash = "",
    storageBlocked = false,
    failAfter = null,
    quotaChars = null,
    referrer = "",
    seed = [],
    // Where a held request waits: in the request itself, or inside reading its body. The
    // second is the slow half on a real phone, and the difference is a whole class of bug.
    holdInBody = false,
    // Who the app signs in as first. Given as a name, because a test that switches accounts
    // reads better than one that switches uids.
    who = "vish"
  } = {}
) {
  const html = readFileSync(join(repo, "index.html"), "utf8");
  const found = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!found) throw new Error("index.html has no module script");

  const source = found[1]
    .replace(
      /import \{ initializeApp \} from "[^"]+";/,
      "const initializeApp = () => ({});"
    )
    .replace(
      /import \{[\s\S]*?\} from "https:\/\/www\.gstatic\.com\/firebasejs[^"]+";/,
      `const getAuth = () => ({});
       const GoogleAuthProvider = class {};
       const signInWithPopup = async () => {};
       const signOut = () => {};
       const onAuthStateChanged = (auth, handler) => { globalThis.__signIn = handler; };`
    );

  const document = makeDocument();
  document.referrer = referrer;
  document._seed(html);
  const listeners = [];
  // The document and the window share one list, so `fire` reaches a handler wherever the
  // app happened to register it.
  document.listeners = listeners;

  /**
   * A `location` that fires `hashchange` when its hash is assigned, the way a browser does.
   *
   * The first version of this harness was a plain object, so assigning `location.hash`
   * changed a string and nothing else — and the app's own `hashchange` handler, which is
   * what actually redraws the screen, never ran. Every tab press in a test therefore only
   * worked because the app ALSO called `render()` by hand, and a real browser was doing
   * both. A harness that cannot see a double render cannot see a missing one either.
   */
  let currentHash = hash;
  // A real address, because the app compares the page it came FROM against this one to
  // tell its own share target apart from a link somebody pasted.
  const ORIGIN = "https://app.test";
  const fakeLocation = {
    origin: ORIGIN,
    pathname: "/",
    search: "",
    get href() {
      return `${ORIGIN}${this.pathname}${this.search}${currentHash}`;
    },
    get hash() {
      return currentHash;
    },
    set hash(value) {
      const next = value && !String(value).startsWith("#") ? `#${value}` : String(value);
      if (next === currentHash) return;
      currentHash = next;
      for (const [name, handler] of listeners) if (name === "hashchange") handler();
    }
  };

  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
    fetch: globalThis.fetch,
    confirm: globalThis.confirm,
    setInterval: globalThis.setInterval
  };

  // What this device already had before the app started — a cache written by an earlier
  // run, so a test can watch what the app does to it rather than only what it writes.
  const store = new Map(seed);
  globalThis.document = document;
  globalThis.window = {
    addEventListener: (name, handler) => listeners.push([name, handler]),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    location: fakeLocation
  };
  globalThis.location = fakeLocation;
  // The share target puts a link in the address when storage refuses it, and the app takes
  // it straight back out so a reload cannot save it twice.
  globalThis.history = {
    replaceState: () => {
      currentHash = "";
    }
  };
  // A browser in a private window, or one set to block site data, THROWS on every one of
  // these rather than returning null. Every use in the app is supposed to survive that.
  const blocked = () => {
    throw new Error("SecurityError: the operation is insecure");
  };
  // A real quota, so the app's own shrinking can be watched rather than simulated. This is
  // how a browser behaves when the box is full: the write throws and nothing is stored.
  const quotaed = (key, value) => {
    if (quotaChars !== null) {
      // The WHOLE box, not just the write in front of it — which is what a browser
      // measures and what "the box is full" actually means. Measuring one value alone
      // meant a small write could never fail, so the share target's own fallback could
      // not be exercised by any test.
      let held = 0;
      for (const [name, held_value] of store) {
        if (name !== key) held += name.length + String(held_value).length;
      }
      if (held + key.length + String(value).length > quotaChars) {
        throw new Error("QuotaExceededError");
      }
    }
    store.set(key, String(value));
  };
  globalThis.localStorage = storageBlocked
    ? { getItem: blocked, setItem: blocked, removeItem: blocked }
    : {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: quotaed,
        removeItem: (key) => store.delete(key)
      };
  // Node defines `navigator` as a getter-only global, so it has to be redefined rather
  // than assigned. The app only reads `navigator.clipboard` and `navigator.serviceWorker`.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true
  });
  globalThis.confirm = () => true;
  // The app starts a background refresh on sign-in. A timer left running would hold the
  // test process open for ever.
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

  // Every draw of the notebook empties this element first, and every draw of Home empties
  // its own. Counting that is how a test can tell one press from two.
  const renderCount = { value: 0 };

  const calls = [];
  // Who is signed in RIGHT NOW, so a sync given as a function can answer with that
  // person's notebook — and so a reply already in the air still carries the notebook of
  // whoever asked for it.
  let signedInAs = who;
  // Requests the test is holding open. This is the only way to reproduce the window that
  // matters: a reply that arrives after the account it belongs to has gone. Only the next
  // few are held, never everything — the account that signs in NEXT has to be able to load
  // its own notebook while the first one's reply is still in the air.
  let held = null;
  let holdCount = 0;
  let skipLeft = 0;
  let replies = null;
  // `failAfter` makes every request past that many fail the way a lost connection does —
  // `fetch` rejecting. Without it no error path in the app is ever executed by a test, and
  // the messages Golden Rule 29 exists to guarantee are all unproven.
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (failAfter !== null && calls.length > failAfter) throw new TypeError("Failed to fetch");
    // Decided NOW, before any waiting — a reply carries the notebook of whoever asked for
    // it, which is exactly what makes a late one dangerous.
    const answer = typeof sync === "function" ? sync(signedInAs) : sync;
    // A test that wants to answer one particular route its own way — for a press that
    // sends several requests and reads what comes back from each one.
    const written = replies ? replies(String(url)) : null;
    let waitHere = null;
    if (held && skipLeft > 0) skipLeft -= 1;
    else if (held && holdCount > 0) {
      holdCount -= 1;
      waitHere = held.promise;
      if (!holdInBody) await waitHere;
    }
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (holdInBody && waitHere) await waitHere;
        if (written) return written;
        if (String(url).includes("/v1/sync")) return answer;
        // The one other route that writes a whole list straight into the store from a
        // reply. It is answered per account so a test can watch one person's list of AI
        // keys arrive under another person's name.
        if (String(url).includes("/v1/keys")) return { ok: true, keys: answer.ai_keys || [] };
        return { ok: true };
      }
    };
  };

  // Every draw of Home empties #homeView and every draw of the notebook empties #clipList,
  // so counting those is how a test tells one press from two.
  for (const id of ["homeView", "clipList"]) {
    const node = document.getElementById(id);
    Object.defineProperty(node, "innerHTML", {
      configurable: true,
      get() {
        return this.textContent;
      },
      set(value) {
        if (String(value) !== "") throw new Error("the app set innerHTML to markup");
        this.children = [];
        this._text = "";
        renderCount.value += 1;
      }
    });
  }

  const dir = mkdtempSync(join(tmpdir(), "cta-app-"));
  const file = join(dir, "app.mjs");
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);

  // The real page signs somebody in; here the test does it, through the app's own handler.
  const signIn = async (uid) => {
    signedInAs = uid;
    await globalThis.__signIn({
      uid, email: `${uid}@example.com`, getIdToken: async () => "t"
    });
    await new Promise((done) => setTimeout(done, 0));
  };
  await signIn(who);
  // The handler syncs and re-renders after awaiting; let those microtasks land.
  await new Promise((done) => setTimeout(done, 0));

  return {
    document,
    calls,
    localStore: store,
    /** How many times the app has drawn a screen. A press should cost exactly one. */
    renders: () => renderCount.value,
    /** Makes every request from now on fail, the way a lost connection does. */
    goOffline() {
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        throw new TypeError("Failed to fetch");
      };
    },
    /** Presses one of the two tabs, the way a finger does. */
    tab(which) {
      const tabs = document.getElementById("tabs");
      const button = tabs.children.find((child) => child.dataset.tab === which);
      if (!button) throw new Error(`no ${which} tab`);
      tabs.onclick({ target: button });
    },
    /** Answers one route the test's own way. Return null to fall through to the default. */
    answerWith(responder) {
      replies = responder;
    },

    /** Switches the notebook to one of its views — list, topics, or a tracker. */
    view(which) {
      const views = document.getElementById("views");
      const button = views.children.find((child) => child.dataset.view === which);
      if (!button) throw new Error(`no ${which} view`);
      views.onclick({ target: button });
    },

    /** Presses a button by the words on it, anywhere on the screen. */
    press(words) {
      const found = ["homeView", "clipList", "clipView", "settingsView"]
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .flatMap((root) => root.walk())
        .find((node) => node.tag === "button" && node.textContent === words);
      if (!found) throw new Error(`no button says "${words}"`);
      return found.onclick();
    },

    /** Signs a different account in, the way switching Google accounts does — no sign-out. */
    signInAs: signIn,
    /**
     * Holds `many` requests open, after letting `letThrough` of them past first.
     *
     * The second argument is how a test reaches the SECOND request of a two-request
     * action — pressing "Add" sends the key and then re-reads the list, and it is the
     * re-read that writes a whole list straight into the store.
     *
     * The release takes `"gave up"` for the other ending: the request never got there at
     * all, which is a different path in the app from a reply that arrived, and the one
     * that was missed the first time.
     */
    hold(many = 1, letThrough = 0) {
      let open;
      let giveUp;
      held = {
        promise: new Promise((done, fail) => { open = done; giveUp = fail; })
      };
      holdCount = many;
      skipLeft = letThrough;
      return (how) => {
        held = null;
        holdCount = 0;
        skipLeft = 0;
        if (how === "gave up") giveUp(new TypeError("Failed to fetch"));
        else open();
      };
    },
    /** Fires a window event the app listens for, e.g. returning to the page. */
    fire(name) {
      for (const [listening, handler] of listeners) if (listening === name) handler();
    },
    $: (id) => document.getElementById(id),
    text: (id) => document.getElementById(id).textContent,
    restore() {
      for (const [name, value] of Object.entries(previous)) globalThis[name] = value;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    }
  };
}

/** A sync response with sensible defaults, so a test only writes the part it is about. */
export function syncPayload(overrides = {}) {
  return {
    now: Date.now(),
    connectors: [],
    relook: { every_days: 14, last_at: null, due: 0, ready: false },
    settings: { ai_provider: "gemini", has_key: true },
    ai_keys: [],
    worker: { last_seen_at: Date.now(), running: true },
    clips: [],
    notes: [],
    questions: [],
    topics: [],
    tasks: [],
    learnings: [],
    item_status: [],
    relooks: [],
    sources: [],
    transcripts: [],
    analyses: [],
    ...overrides
  };
}
