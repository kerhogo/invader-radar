/**
 * Tests du pipeline de données — sans réseau : fetch est remplacé par un faux site.
 * Usage : npm test
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { distanceM, jsonLines, readJsonIfExists } from "./lib/pipeline.mjs";
import { RETRY_WAITS_MS, get, parseRows, runPass, timing } from "./fetch-spotter.mjs";

/* ---------- jsonLines ---------- */

test("jsonLines : même contenu qu'un JSON compact, une entrée par ligne", () => {
  const dataset = {
    generated: "2026-11-13T15:06:54.651Z",
    items: [{ id: "PA_01", city: "PA", status: "ok" }, { id: "PA_02", city: "PA", lat: 48.85, lng: 2.35, status: "destroyed" }],
    cities: { PA: { name: "Paris", count: 2 }, LDN: { name: "London", count: 0 } }
  };
  const text = jsonLines(dataset);
  assert.deepEqual(JSON.parse(text), dataset);
  const lines = text.split("\n");
  assert.ok(lines.includes('{"id":"PA_01","city":"PA","status":"ok"},'));
  assert.ok(lines.includes('"LDN":{"name":"London","count":0}'));
  assert.ok(text.endsWith("}\n"));
});

test("jsonLines : collections vides, scalaires, GeoJSON et valeurs undefined", () => {
  for (const value of [
    { entries: [] },
    { stats: {}, list: [1, "a", null], flag: true, n: 3 },
    { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [2.3, 48.8] }, properties: { name: "Odéon" } }] },
    { sources: { siwd: { version: 6 }, note: "mixte" } },
    { absent: undefined, list: [undefined, 1], kept: 1 }
  ]) {
    // même résultat que JSON.stringify : clé undefined omise, undefined dans un tableau → null
    assert.deepEqual(JSON.parse(jsonLines(value)), JSON.parse(JSON.stringify(value)));
  }
});

/* ---------- readJsonIfExists ---------- */

test("readJsonIfExists : null si absent, erreur si illisible, BOM toléré", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ir-test-"));
  try {
    assert.equal(await readJsonIfExists(join(dir, "absent.json")), null);
    await writeFile(join(dir, "bom.json"), String.fromCharCode(0xfeff) + JSON.stringify({ ok: true }));
    assert.deepEqual(await readJsonIfExists(join(dir, "bom.json")), { ok: true });
    await writeFile(join(dir, "conflit.json"), '{"entries":[\n<<<<<<< HEAD\n');
    await assert.rejects(readJsonIfExists(join(dir, "conflit.json")), /illisible/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("distanceM : ordre de grandeur correct", () => {
  // Notre-Dame → tour Eiffel : ~4,1 km
  const d = distanceM(48.85297, 2.34989, 48.85837, 2.29448);
  assert.ok(d > 4000 && d < 4200, String(d));
  assert.equal(distanceM(48.85, 2.35, 48.85, 2.35), 0);
});

/* ---------- fetch-spotter : préparation commune ---------- */

const realFetch = globalThis.fetch;
const realWaits = [...RETRY_WAITS_MS];
const realDelay = timing.delayMs;
const realConsole = { log: console.log, warn: console.warn };
let logged = [];
beforeEach(() => {
  // ni attente réelle, ni sortie console (sous GitHub Actions, un « ::warning:: » créerait une annotation)
  RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...realWaits.map(() => 1));
  timing.delayMs = 0;
  logged = [];
  console.log = console.warn = (...args) => { logged.push(args.join(" ")); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...realWaits);
  timing.delayMs = realDelay;
  Object.assign(console, realConsole);
});

/** Simule fetch : chaque appel consomme l'étape suivante — une erreur à lever, ou une fabrique de Response. */
function fakeFetch(...steps) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step();
  };
  return calls;
}
const socketClosed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });

/* ---------- fetch-spotter : reprises réseau ---------- */

test("get : une connexion coupée est rejouée, puis la page est rendue", async () => {
  const calls = fakeFetch(socketClosed(), socketClosed(), () => new Response("<html>ok</html>"));
  assert.equal(await get("/villes.php"), "<html>ok</html>");
  assert.equal(calls.length, 3);
  assert.match(calls[0].init.headers["User-Agent"], /^InvaderRadar-DataPipeline\//);
  assert.ok(calls[0].init.signal instanceof AbortSignal, "chaque requête a un délai maximal");
});

test("get : 503, 429 et 520 sont rejoués, le corps POST est renvoyé à l'identique", async () => {
  const calls = fakeFetch(
    () => new Response("", { status: 503 }), () => new Response("", { status: 429 }),
    () => new Response("", { status: 520 }), () => new Response("lignes"));
  assert.equal(await get("/listing.php", { method: "POST", body: "ville=PA&arron=00&page=1" }), "lignes");
  assert.deepEqual(calls.map(c => c.init.body), Array(4).fill("ville=PA&arron=00&page=1"));
});

test("get : abandon après le nombre de reprises prévu", async () => {
  const calls = fakeFetch(socketClosed());
  await assert.rejects(get("/villes.php"), /fetch failed/);
  assert.equal(calls.length, RETRY_WAITS_MS.length + 1);
});

test("get : une erreur 404 n'est pas rejouée", async () => {
  const calls = fakeFetch(() => new Response("", { status: 404 }));
  await assert.rejects(get("/inconnu.php"), /HTTP 404/);
  assert.equal(calls.length, 1);
});

test("get : les cookies de session sont conservés d'une requête à l'autre", async () => {
  const withCookies = () => new Response("a", { headers: [["set-cookie", "autre=1; path=/"], ["set-cookie", "PHPSESSID=abc123; path=/; HttpOnly"]] });
  const calls = fakeFetch(withCookies, () => new Response("b"));
  await get("/villes.php");
  await get("/news.php");
  assert.match(calls[1].init.headers.Cookie, /PHPSESSID=abc123/);
  assert.match(calls[1].init.headers.Cookie, /autre=1/);
});

/* ---------- fetch-spotter : lecture des lignes ---------- */

test("parseRows : identifiant, points, statut, lieu — et ligne sans statut conservée vide", () => {
  const html = `<table>
<tr class="haut"><td><b>PA_92 [30 pts]</b><br/>(Paris 4e)<br/>Dernier &eacute;tat connu : <img src="ok.png"> OK<br/>Date et source : 2026-11-01, terrain<</td></tr>
<tr class="haut"><td><b>PA_93 [20 pts]</b><br/>Dernier &eacute;tat connu : <img src="ko.png"> D&eacute;truit !<br/></td></tr>
<tr class="haut"><td><b>PA_94 [10 pts]</b><br/>format inattendu</td></tr>
</table>`;
  const rows = parseRows(html);
  assert.deepEqual(rows.map(r => [r.id, r.points, r.status]), [["PA_92", 30, "OK"], ["PA_93", 20, "Détruit"], ["PA_94", 10, ""]]);
  assert.equal(rows[0].location, "Paris 4e");
});

/* ---------- fetch-spotter : passe complète contre un faux site ---------- */

const PER_PAGE = 20;
const cityCode = n => "C" + String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
/** 85 villes de 50 invaders : assez pour franchir les planchers d'une passe plausible (80 villes, 4000 statuts). */
const baseRows = () => Object.fromEntries(Array.from({ length: 85 }, (_, n) => [cityCode(n), 50]));

/**
 * Faux invader-spotter.art. `rows` : lignes listées par ville ; `announced` : compteur affiché
 * par villes.php (par défaut = lignes listées) ; `blank(code, page, essai)` : vrai pour répondre
 * une page vide en HTTP 200 ; `newsDown` : news.php en panne.
 */
function fakeSite({ rows, announced = {}, blank = () => false, newsDown = false }) {
  const requests = [];
  const tries = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push(path + (init.body ? "?" + init.body : ""));
    if (path === "/villes.php") {
      const html = Object.keys({ ...rows, ...announced })
        .map(code => `<img onclick='envoi("${code}")' alt='Ville ${code}' title='Ville ${code} (${announced[code] ?? rows[code]} / ${announced[code] ?? rows[code]})'>`)
        .join("\n");
      return new Response(html, { headers: { "set-cookie": "PHPSESSID=test; path=/" } });
    }
    if (path === "/news.php") {
      if (newsDown) return new Response("", { status: 404 });
      return new Response("<div id='mois202611'><p class='news'><b>13 :</b> Une nouvelle.</p></div>");
    }
    const form = new URLSearchParams(init.body);
    const code = form.get("ville");
    const page = Number(form.get("page"));
    const key = `${code}:${page}`;
    tries.set(key, (tries.get(key) ?? 0) + 1);
    if (blank(code, page, tries.get(key))) return new Response("<html></html>");
    const total = rows[code] ?? 0;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    let html = "";
    for (let n = (page - 1) * PER_PAGE + 1; n <= Math.min(total, page * PER_PAGE); n++) {
      html += `<tr class="haut"><td><b>${code}_${n} [10 pts]</b><br/>Dernier &eacute;tat connu : <img src="ok.png"> OK<br/></td></tr>\n`;
    }
    for (let p = 1; p <= pages; p++) html += `<a href="javascript:changepage(${p})">${p}</a>`;
    return new Response(html);
  };
  return requests;
}

/** Dépôt jetable portant la « dernière publication » qui sert de référence à la passe. */
async function fakeRepo(rows, { perCity = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ir-pass-"));
  await mkdir(join(root, "public", "data"), { recursive: true });
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  await writeFile(join(root, "public", "data", "meta.json"),
    JSON.stringify({ sources: { spotter: { count: total, ...(perCity ? { perCity: rows } : {}) } } }));
  const cities = Object.fromEntries(Object.entries(rows).map(([code, count]) => [code, { name: code, count, official: count }]));
  await writeFile(join(root, "public", "data", "invaders.json"), JSON.stringify({ items: [], cities }));
  return root;
}
const cachePath = root => join(root, ".cache", "spotter.json");
const withRepo = async (rows, options, run) => {
  const root = await fakeRepo(rows, options);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("passe : site sain → cache complet, une requête par page", async () => {
  await withRepo(baseRows(), {}, async root => {
    const requests = fakeSite({ rows: baseRows() });
    const out = await runPass({ root, city: undefined, allowMissing: false });
    assert.equal(Object.keys(out.items).length, 85 * 50);
    assert.equal(out.news.length, 1);
    assert.equal(requests.filter(r => r === "/villes.php").length, 1, "villes.php n'est demandé qu'une fois");
    assert.equal(requests.filter(r => r.startsWith("/listing.php")).length, 85 * 3);
    assert.equal(Object.keys(JSON.parse(await readFile(cachePath(root), "utf8")).items).length, 85 * 50);
  });
});

test("passe : page vide passagère au milieu d'une ville → second essai, cache complet", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: baseRows(), blank: (code, page, attempt) => code === "CAC" && page === 2 && attempt === 1 });
    const out = await runPass({ root, city: undefined, allowMissing: false });
    assert.equal(Object.keys(out.items).filter(id => id.startsWith("CAC_")).length, 50);
    assert.ok(logged.some(l => /CAC : 20 ligne\(s\) lue\(s\)/.test(l)), "le second essai est journalisé");
  });
});

test("passe : liste d'une ville coupée durablement → erreur, aucun cache écrit", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: baseRows(), blank: (code, page) => code === "CAC" && page >= 2 });
    await assert.rejects(runPass({ root, city: undefined, allowMissing: false }), /liste vide ou coupée : CAC \(20 lignes pour 50 connues\)/);
    assert.equal(existsSync(cachePath(root)), false);
  });
});

test("passe : même contrôle sans perCity publié (première passe) — repli sur l'effectif des villes", async () => {
  await withRepo(baseRows(), { perCity: false }, async root => {
    fakeSite({ rows: baseRows(), blank: (code, page) => code === "CAC" && page >= 2 });
    await assert.rejects(runPass({ root, city: undefined, allowMissing: false }), /liste vide ou coupée : CAC/);
  });
});

test("passe : --allow-missing accepte une ville réellement réduite", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: { ...baseRows(), CAC: 20 } });
    const out = await runPass({ root, city: undefined, allowMissing: true });
    assert.equal(Object.keys(out.items).length, 85 * 50 - 30);
    assert.ok(existsSync(cachePath(root)));
  });
});

test("passe : ville nouvelle annoncée mais pas encore listée → simple avertissement", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: baseRows(), announced: { NEW: 12 } });
    const out = await runPass({ root, city: undefined, allowMissing: false });
    assert.equal(Object.keys(out.items).length, 85 * 50);
    assert.ok(out.cities.NEW, "la ville figure au référentiel");
    assert.ok(logged.some(l => /NEW : ville annoncée \(12\) mais pas encore listée/.test(l)));
  });
});

test("passe : ville nouvelle qui se remplit peu à peu (2 lignes pour 60 annoncées) → acceptée", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: { ...baseRows(), NEW: 2 }, announced: { NEW: 60 } });
    const out = await runPass({ root, city: undefined, allowMissing: false });
    assert.equal(Object.keys(out.items).filter(id => id.startsWith("NEW_")).length, 2);
  });
});

test("passe : ville publiée absente du référentiel → arrêt avant la passe", async () => {
  await withRepo(baseRows(), {}, async root => {
    const { CAC, ...withoutOne } = baseRows();
    const requests = fakeSite({ rows: withoutOne });
    await assert.rejects(runPass({ root, city: undefined, allowMissing: false }), /référentiel incomplet — .*CAC/);
    assert.deepEqual(requests, ["/villes.php"], "aucune autre requête n'est partie");
  });
});

test("passe : news.php en panne → statuts tout de même récupérés", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: baseRows(), newsDown: true });
    const out = await runPass({ root, city: undefined, allowMissing: false });
    assert.deepEqual(out.news, []);
    assert.equal(Object.keys(out.items).length, 85 * 50);
  });
});

test("passe : --city écrit un fichier à part et laisse le cache complet intact", async () => {
  await withRepo(baseRows(), {}, async root => {
    fakeSite({ rows: baseRows() });
    const out = await runPass({ root, city: "CAC", allowMissing: false });
    assert.equal(Object.keys(out.items).length, 50);
    assert.ok(existsSync(join(root, ".cache", "spotter-CAC.json")));
    assert.equal(existsSync(cachePath(root)), false);
  });
});
