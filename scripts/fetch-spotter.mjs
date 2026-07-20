/**
 * Récupère les statuts à jour depuis invader-spotter.art (référence communautaire).
 *
 * Scraping poli : une passe par jour maximum (CI), ~1,8 s entre chaque requête,
 * User-Agent identifiant le projet. Résultat mis en cache (.cache/spotter.json) ;
 * l'application, elle, ne contacte jamais le site.
 *
 * Produit aussi le référentiel officiel des villes (codes, noms, compteurs)
 * depuis villes.php — la même source que la carte officielle du site.
 *
 * Usage : node scripts/fetch-spotter.mjs [--city=VRS] (option : limiter à une ville, pour tester)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache");
const BASE = "https://www.invader-spotter.art";
const UA = "InvaderRadar-DataPipeline/0.1 (+https://github.com/; projet perso non commercial; 1 passe/jour)";
const DELAY_MS = 1800;
const onlyCity = process.argv.find(a => a.startsWith("--city="))?.split("=")[1];

const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = "";
async function get(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "User-Agent": UA,
      "Referer": BASE + "/villes.php",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {})
    }
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(s) {
  const named = {
    eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
    icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ucirc: "û", uuml: "ü", ugrave: "ù",
    ccedil: "ç", ntilde: "ñ", aacute: "á", oacute: "ó", uacute: "ú", iacute: "í",
    Eacute: "É", Agrave: "À", amp: "&", apos: "'", quot: '"', nbsp: " ", ndash: "–", oslash: "ø", aring: "å", atilde: "ã"
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}

async function cityReferential() {
  const html = await get("/villes.php");
  const cities = {};
  const re = /envoi\("([A-Z0-9]+)"\)'\s*alt='([^']*)'\s*title='[^(']*\((\d+)\s*\/\s*(\d+)\)/g;
  for (const m of html.matchAll(re)) {
    const [, code, name, a, b] = m;
    cities[code] = { name: decodeEntities(name), official: Math.max(Number(a), Number(b)) };
  }
  return cities;
}

/** News du site (page news.php) : sections par mois, entrées par jour. */
async function scrapeNews(maxEntries = 100) {
  const html = await get("/news.php");
  const entries = [];
  const monthRe = /<div id='mois(\d{6})'>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(monthRe)) {
    const ym = m[1];
    let currentDay = null;
    for (const pm of m[2].matchAll(/<p class='news'>([\s\S]*?)<\/p>/g)) {
      let text = pm[1];
      const dm = text.match(/^<b>(\d{1,2})\s*:<\/b>/);
      if (dm) { currentDay = dm[1].padStart(2, "0"); text = text.replace(/^<b>[^<]*<\/b>/, ""); }
      if (!currentDay) continue;
      const plain = decodeEntities(
        text.replace(/<[^>]+>/g, " ")
      ).replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").trim();
      if (plain) entries.push({ date: `${ym.slice(0, 4)}-${ym.slice(4)}-${currentDay}`, text: plain });
      if (entries.length >= maxEntries) return entries;
    }
  }
  return entries;
}

function parseRows(html) {
  const out = [];
  for (const chunk of html.split(/<tr class="haut">/).slice(1)) {
    const id = chunk.match(/<b>([A-Z0-9]+_\d+) \[([^\]]*)\]<\/b>/);
    if (!id) continue;
    const status = chunk.match(/Dernier &eacute;tat connu : <img[^>]*>\s*([^<]+)</);
    const date = chunk.match(/Date et source : ([^<]*)</);
    const loc = chunk.match(/<br\/?>\(([^)]{3,120})\)<br/);
    out.push({
      id: id[1],
      points: parseInt(id[2]) || 0,
      status: status ? decodeEntities(status[1].trim().replace(/\s*!$/, "")) : "",
      date: date ? decodeEntities(date[1].trim()) : "",
      location: loc ? decodeEntities(loc[1]) : ""
    });
  }
  return out;
}

async function listCity(code, arron = "00") {
  const items = new Map();
  let page = 1;
  let maxPage = 1;
  for (;;) {
    const body = new URLSearchParams({ ville: code, arron, page: String(page) }).toString();
    const html = await get("/listing.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const rows = parseRows(html);
    const before = items.size;
    for (const r of rows) items.set(r.id, r);
    for (const m of html.matchAll(/changepage\((\d+)\)/g)) maxPage = Math.max(maxPage, Number(m[1]));
    if (rows.length === 0 || items.size === before || page >= Math.min(maxPage, 150)) break;
    page++;
    await sleep(DELAY_MS);
  }
  return items;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await get("/villes.php"); // initialise la session PHP

  const cities = await cityReferential();
  console.log(`Référentiel : ${Object.keys(cities).length} villes officielles`);

  await sleep(DELAY_MS);
  const news = await scrapeNews();
  console.log(`News : ${news.length} entrées`);

  const items = {};
  const codes = onlyCity ? [onlyCity] : Object.keys(cities);
  for (const code of codes) {
    await sleep(DELAY_MS);
    let got = await listCity(code);
    // Paris & très grosses villes : si le tout-venant est tronqué, passer par arrondissements
    const expected = cities[code]?.official ?? 0;
    if (expected > 0 && got.size < expected * 0.8 && code === "PA") {
      const arrons = ["01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","18","19","20","77","92","93","94","95"];
      got = new Map();
      for (const a of arrons) {
        await sleep(DELAY_MS);
        for (const [id, r] of await listCity(code, a)) got.set(id, r);
      }
    }
    for (const [id, r] of got) items[id] = r;
    console.log(`${code.padEnd(5)} ${String(got.size).padStart(4)} / ${expected || "?"}`);
  }

  const out = {
    date: new Date().toISOString().slice(0, 10),
    cities,
    news,
    items
  };
  await writeFile(join(CACHE, "spotter.json"), JSON.stringify(out));
  console.log(`✔ .cache/spotter.json : ${Object.keys(items).length} statuts`);
}

main().catch(err => { console.error(err); process.exit(1); });
