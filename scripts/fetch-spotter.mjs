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
 * Robustesse : chaque requête a un délai maximal et est rejouée avec une attente
 * croissante sur les pannes passagères (connexion coupée, 429, 5xx). Une passe
 * manifestement incomplète — ville déjà publiée absente du référentiel, liste vide
 * ou coupée en cours de pagination — n'écrit rien et sort en erreur : le pipeline ne
 * doit jamais publier des statuts partiels. La référence est la dernière publication
 * (public/data/meta.json et invaders.json).
 *
 * Usage : node scripts/fetch-spotter.mjs [--city=VRS] [--allow-missing]
 *   --city=CODE     : limite à une ville, pour tester — écrit .cache/spotter-CODE.json,
 *                     jamais le cache complet que build-data consomme.
 *   --allow-missing : accepte une passe où manquent des villes ou des lignes déjà publiées
 *                     (seulement si Invader Spotter les a vraiment retirées).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonIfExists, sleep, warn } from "./lib/pipeline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.invader-spotter.art";
const UA = "InvaderRadar-DataPipeline/0.1 (+https://github.com/; projet perso non commercial; 1 passe/jour)";
/** Pause entre deux requêtes (objet modifiable : les tests la ramènent à zéro). */
export const timing = { delayMs: 1800 };
/** Délai maximal d'une requête : une connexion qui pend ne doit pas bloquer le run. */
const TIMEOUT_MS = 30_000;
/** Attentes avant chaque nouvel essai d'une requête en échec (5 reprises : le site a ~8 min pour revenir). */
export const RETRY_WAITS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
const RETRY_WAIT_MAX_MS = 300_000;
/** Pannes passagères : erreurs serveur, délai dépassé, limitation de débit. */
const isRetryable = status => status >= 500 || status === 408 || status === 425 || status === 429;
const MAX_PAGES = 150;
/** Lignes déjà connues d'une ville qui peuvent manquer avant de conclure que sa liste a été coupée. */
const MAX_MISSING_ROWS = 2;
const MAX_MISSING_SHARE = 0.05;
const ALLOW_MISSING = process.argv.includes("--allow-missing");
/** Sous ce ratio du compteur officiel, la liste de Paris est tronquée : repli par arrondissement. */
const SHORT_LIST_RATIO = 0.8;
/** Planchers d'une passe complète plausible. */
const MIN_CITIES = 80;
const MIN_ITEMS = 4000;
const MIN_SHARE_OF_PUBLISHED = 0.97;
/** Part de lignes sans statut lisible au-delà de laquelle on conclut à une dérive du HTML. */
const MAX_NO_STATUS_SHARE = 0.02;
const onlyCity = process.argv.find(a => a.startsWith("--city="))?.split("=")[1];

const cookies = new Map();
const rowStats = { rows: 0, noStatus: 0 };

const describe = err => err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);

export async function get(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    let retryAfterMs = 0;
    try {
      const res = await fetch(BASE + path, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": UA,
          "Referer": BASE + "/villes.php",
          ...(cookies.size ? { Cookie: [...cookies.values()].join("; ") } : {}),
          ...(init.headers ?? {})
        }
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0].trim();
        cookies.set(pair.split("=")[0], pair);
      }
      if (res.ok) return await res.text();
      res.body?.cancel().catch(() => {}); // libère la connexion sans attendre
      failure = new Error(`${path} → HTTP ${res.status}`);
      // 4xx hors 408/425/429 : la requête elle-même est refusée, la rejouer n'y changera rien
      if (!isRetryable(res.status)) failure.permanent = true;
      retryAfterMs = (Number(res.headers.get("retry-after")) || 0) * 1000;
    } catch (err) {
      failure = err; // connexion coupée, délai dépassé, DNS…
    }
    if (failure.permanent || attempt >= RETRY_WAITS_MS.length) throw failure;
    const wait = Math.min(Math.max(RETRY_WAITS_MS[attempt], retryAfterMs), RETRY_WAIT_MAX_MS);
    console.warn(`! ${path} : ${describe(failure)} — nouvel essai ${attempt + 1}/${RETRY_WAITS_MS.length} dans ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
}

function decodeEntities(s) {
  const named = {
    eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
    icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ucirc: "û", uuml: "ü", ugrave: "ù",
    ccedil: "ç", ntilde: "ñ", aacute: "á", oacute: "ó", uacute: "ú", iacute: "í",
    Eacute: "É", Agrave: "À", amp: "&", apos: "'", quot: '"', nbsp: " ", ndash: "–", oslash: "ø", aring: "å", atilde: "ã",
    Egrave: "È", Ecirc: "Ê", Ccedil: "Ç", Ocirc: "Ô", oelig: "œ", OElig: "Œ", rsquo: "’", lsquo: "‘",
    laquo: "«", raquo: "»", hellip: "…", mdash: "—", deg: "°", euro: "€"
  };
  return s
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, hex, n) => {
      const code = Number.parseInt(n, hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
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

export function parseRows(html) {
  const out = [];
  for (const chunk of html.split(/<tr class="haut">/).slice(1)) {
    const id = chunk.match(/<b>([A-Z0-9]+_\d+) \[([^\]]*)\]<\/b>/);
    if (!id) continue;
    const status = chunk.match(/Dernier &eacute;tat connu : <img[^>]*>\s*([^<]+)</);
    const date = chunk.match(/Date et source : ([^<]*)</);
    const loc = chunk.match(/<br\/?>\(([^)]{3,120})\)<br/);
    rowStats.rows++;
    // Ligne conservée même sans statut (build-data garde alors le statut du socle) mais comptée :
    // en nombre, c'est le signe que le HTML du site a changé.
    if (!status) rowStats.noStatus++;
    out.push({
      id: id[1],
      points: Number.parseInt(id[2], 10) || 0,
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
    if (rows.length === 0 || items.size === before || page >= Math.min(maxPage, MAX_PAGES)) break;
    page++;
    await sleep(timing.delayMs);
  }
  return items;
}

/** Nouvelle session PHP : listing.php répond par une page vide quand la sienne est perdue. */
async function renewSession() {
  cookies.clear();
  await sleep(timing.delayMs);
  await get("/villes.php");
  await sleep(timing.delayMs);
}

/**
 * Une passe complète (ou sur une seule ville). `root` : racine du dépôt — la dernière
 * publication y sert de référence, le cache y est écrit (les tests passent un dossier jetable).
 */
export async function runPass({ root = ROOT, city = onlyCity, allowMissing = ALLOW_MISSING } = {}) {
  const cacheDir = join(root, ".cache");
  await mkdir(cacheDir, { recursive: true });
  cookies.clear();
  rowStats.rows = rowStats.noStatus = 0;

  // Première requête : elle ouvre aussi la session PHP (cookie) dont listing.php a besoin.
  const cities = await cityReferential();
  const cityCount = Object.keys(cities).length;
  console.log(`Référentiel : ${cityCount} villes officielles`);
  if (cityCount < MIN_CITIES) {
    throw new Error(`référentiel suspect : ${cityCount} villes (< ${MIN_CITIES}) — le HTML de villes.php a peut-être changé`);
  }

  // Référence : la dernière publication. `perCity` = lignes Spotter par ville lors de la passe
  // précédente ; à défaut (première passe après l'ajout de ce contrôle), l'effectif publié des
  // villes officielles. Vide à la toute première génération : aucun contrôle par ville.
  const publishedMeta = await readJsonIfExists(join(root, "public", "data", "meta.json"));
  const publishedCities = (await readJsonIfExists(join(root, "public", "data", "invaders.json")))?.cities ?? {};
  const perCity = publishedMeta?.sources?.spotter?.perCity
    ?? Object.fromEntries(Object.entries(publishedCities).filter(([, c]) => c.official).map(([code, c]) => [code, c.count]));
  const known = code => perCity[code] ?? 0;
  const isCut = (code, got) => known(code) - got.size > Math.max(MAX_MISSING_ROWS, known(code) * MAX_MISSING_SHARE);

  // Une ville ne quitte pas le référentiel : s'il en manque une déjà publiée, villes.php a été lu
  // partiellement. Autant s'arrêter avant les ~270 requêtes de la passe.
  const missingCities = Object.keys(perCity).filter(code => known(code) > 0 && !cities[code]);
  if (missingCities.length && !city) {
    const message = `ville(s) publiée(s) absente(s) de villes.php : ${missingCities.join(", ")}`;
    if (!allowMissing) throw new Error(`référentiel incomplet — ${message} (--allow-missing si le site les a vraiment retirées)`);
    warn(`${message} — accepté (--allow-missing)`);
  }

  await sleep(timing.delayMs);
  let news = [];
  try {
    news = await scrapeNews();
    console.log(`News : ${news.length} entrées`);
    if (news.length === 0) warn("news.php : aucune entrée lue — le HTML de la page a peut-être changé");
  } catch (err) {
    // les news sont un complément : leur panne ne doit pas coûter la passe de statuts
    warn(`news.php indisponible (${describe(err)}) — pas de news aujourd'hui`);
  }

  const items = {};
  const shrunk = []; // villes déjà publiées dont la liste est vide ou coupée, même après un second essai
  const codes = city ? [city] : Object.keys(cities);
  for (const code of codes) {
    await sleep(timing.delayMs);
    const expected = cities[code]?.official ?? 0;
    const got = await listCity(code);
    if ((expected > 0 && got.size === 0) || isCut(code, got)) {
      // Session perdue, page vide en HTTP 200, pagination interrompue : second essai, résultats fusionnés.
      console.warn(`! ${code} : ${got.size} ligne(s) lue(s) (${known(code)} connues, ${expected} annoncées) — nouvelle session et second essai`);
      await renewSession();
      for (const [id, r] of await listCity(code)) got.set(id, r);
    }
    // Paris : si le tout-venant est tronqué, compléter par arrondissement
    if (expected > 0 && got.size < expected * SHORT_LIST_RATIO && code === "PA") {
      const arrons = ["01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","18","19","20","77","92","93","94","95"];
      for (const a of arrons) {
        await sleep(timing.delayMs);
        for (const [id, r] of await listCity(code, a)) got.set(id, r);
      }
    }
    if (known(code) > 0 && (got.size === 0 || isCut(code, got))) {
      shrunk.push(`${code} (${got.size} lignes pour ${known(code)} connues)`);
    } else if (expected > 0 && got.size === 0) {
      // Ville nouvelle : le site publie son compteur avant sa première ligne. Rien à perdre, on attend.
      warn(`${code} : ville annoncée (${expected}) mais pas encore listée — ignorée pour cette passe`);
    }
    for (const [id, r] of got) items[id] = r;
    console.log(`${code.padEnd(5)} ${String(got.size).padStart(4)} / ${expected || "?"}`);
  }

  const total = Object.keys(items).length;
  const out = {
    date: new Date().toISOString().slice(0, 10),
    cities,
    news,
    items,
    stats: { ...rowStats }
  };

  if (city) {
    const file = `spotter-${city}.json`;
    await writeFile(join(cacheDir, file), JSON.stringify(out));
    console.log(`✔ .cache/${file} : ${total} statuts (essai sur une ville — le cache complet n'est pas modifié)`);
    return out;
  }

  // Une passe incomplète ne doit pas remplacer le cache : build-data publierait des statuts
  // périmés pour les absents. Deux familles de refus :
  //  - lecture défaillante (HTML modifié, base presque vide) : jamais contournable ;
  //  - base qui semble avoir rétréci : contournable par --allow-missing si le retrait est réel.
  const broken = [];
  if (total < MIN_ITEMS) broken.push(`${total} statuts (< ${MIN_ITEMS})`);
  if (rowStats.noStatus > rowStats.rows * MAX_NO_STATUS_SHARE) {
    broken.push(`${rowStats.noStatus} lignes sans statut lisible sur ${rowStats.rows} (HTML de listing.php modifié ?)`);
  }
  const shrink = [];
  if (shrunk.length) shrink.push(`liste vide ou coupée : ${shrunk.join(", ")}`);
  const published = publishedMeta?.sources?.spotter?.count;
  if (published && total < published * MIN_SHARE_OF_PUBLISHED) {
    shrink.push(`${total} statuts contre ${published} à la dernière publication`);
  }
  if (shrink.length && allowMissing) {
    warn(`passe acceptée malgré : ${shrink.join(" ; ")} (--allow-missing)`);
    shrink.length = 0;
  }
  if (broken.length || shrink.length) {
    throw new Error(`passe incomplète, cache non écrit — ${[...broken, ...shrink].join(" ; ")}`
      + (shrink.length ? " (--allow-missing si Invader Spotter a vraiment retiré ces lignes)" : ""));
  }

  await writeFile(join(cacheDir, "spotter.json"), JSON.stringify(out));
  console.log(`✔ .cache/spotter.json : ${total} statuts`);
  return out;
}

// Exécuté seulement en ligne de commande (les tests importent le module sans lancer la passe)
if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runPass().catch(err => { console.error(err); process.exit(1); });
}
