/**
 * Feuille tuto « Comment récupérer mon uid ? » — deux méthodes (iPhone / Android).
 * L'uid n'est pas exposé publiquement par FlashInvaders : il faut intercepter
 * une requête de l'app officielle. Chargée à la demande (code-split).
 */
import { escapeHtml } from "./dashboard";

type Method = "ios" | "android";

const IOS_STEPS: Array<[string, string[]]> = [
  ["1 · Préparer l'interception", [
    "Installe <b>Proxyman</b> depuis l'App Store.",
    "Ouvre Proxyman et démarre l'interception : accepte l'ajout d'une configuration <b>VPN locale</b> (un VPN factice, tout reste sur ton téléphone).",
    "Dans Proxyman, choisis <b>Install Certificate / Enable HTTPS</b> et télécharge le profil de configuration.",
    "Ouvre <b>Réglages</b> → tout en haut sous ton nom, tape <b>Profil téléchargé</b> et installe-le.",
    "<b>Étape cruciale</b> : Réglages → Général → Informations → tout en bas <b>Réglages des certificats</b> → active l'interrupteur du certificat <b>Proxyman CA</b>. Sans ça, le trafic reste chiffré et illisible."
  ]],
  ["2 · Extraire l'uid", [
    "Ouvre l'app officielle <b>FlashInvaders</b>.",
    "Va sur ton <b>profil</b> ou rafraîchis ta page : l'app envoie ton identifiant au serveur.",
    "Retourne dans Proxyman et cherche une requête vers <b>api.space-invaders.com</b>.",
    "Ouvre-la, onglet <b>Request</b> → section <b>Query</b> (ou l'URL brute) : repère le paramètre <b>uid</b> suivi d'une longue suite (ex. <code>03F305B5-…</code>).",
    "Copie cette valeur complète — c'est ta clé, à coller dans le champ uid de l'app."
  ]],
  ["3 · Nettoyage sécurité", [
    "Dans Proxyman, coupe l'interrupteur principal : l'icône VPN disparaît de la barre d'état.",
    "Réglages → Général → Informations → Réglages des certificats : <b>désactive</b> le certificat Proxyman CA.",
    "Réglages → Général → <b>VPN et gestion de l'appareil</b> → sélectionne le profil Proxyman → <b>Supprimer le profil</b>.",
    "Ton iPhone est de nouveau dans sa configuration standard."
  ]]
];

const ANDROID_STEPS: Array<[string, string[]]> = [
  ["1 · Préparer le téléphone et le PC", [
    "Réglages → À propos du téléphone → tape <b>7 fois</b> sur <b>Numéro de build</b> pour activer le mode développeur.",
    "Réglages → Système → Options pour les développeurs → active le <b>Débogage USB</b>.",
    "Sur ton PC/Mac, télécharge <b>SDK Platform-Tools</b> (ADB) de Google.",
    "Branche le téléphone en USB, ouvre un terminal dans le dossier ADB : <code>adb devices</code>, puis accepte l'autorisation à l'écran du téléphone."
  ]],
  ["2 · Extraire l'uid via les logs", [
    "Purge les anciens logs : <code>adb logcat -c</code>.",
    "Lance l'écoute — Mac/Linux : <code>adb logcat | grep -i \"uid=\"</code> · Windows : <code>adb logcat | Select-String \"uid=\"</code>.",
    "Ouvre <b>FlashInvaders</b> et rafraîchis ton profil.",
    "Si l'app journalise ses requêtes, une ligne <code>uid=03F305B5-…</code> défile : copie la valeur."
  ]],
  ["3 · Remise en état", [
    "Réglages → Options pour les développeurs → <b>désactive le Débogage USB</b>.",
    "Si rien n'apparaît, les logs réseau ont été retirés de la version publique : passe alors par une interception TLS avec <b>PCAPdroid</b> (même principe que Proxyman sur iPhone)."
  ]]
];

function section(steps: Array<[string, string[]]>): string {
  return steps.map(([title, items]) => `
    <div class="tuto-step">
      <h4>${escapeHtml(title)}</h4>
      <ol>${items.map(i => `<li>${i}</li>`).join("")}</ol>
    </div>`).join("");
}

export function openUidHelp(): void {
  document.getElementById("uid-help")?.remove();
  let method: Method = /android/i.test(navigator.userAgent) ? "android" : "ios";

  const sheet = document.createElement("div");
  sheet.id = "uid-help";
  sheet.className = "sheet-overlay";
  sheet.innerHTML = `
    <div class="sheet">
      <button class="close" aria-label="Fermer">✕</button>
      <h3>Récupérer ton uid FlashInvaders</h3>
      <p class="hint">FlashInvaders ne publie pas ton uid : il faut « écouter » une requête de l'app officielle une seule fois. Choisis ta plateforme.</p>
      <div class="seg" id="uid-method">
        <button data-m="ios" class="${method === "ios" ? "active" : ""}">iPhone</button>
        <button data-m="android" class="${method === "android" ? "active" : ""}">Android</button>
      </div>
      <div id="uid-steps">${section(method === "ios" ? IOS_STEPS : ANDROID_STEPS)}</div>
      <p class="hint">L'uid est une donnée de lecture seule (ta galerie publique). Cette manipulation ne donne aucun accès à ton compte.</p>
    </div>`;

  sheet.querySelector(".close")!.addEventListener("click", () => sheet.remove());
  sheet.addEventListener("click", ev => { if (ev.target === sheet) sheet.remove(); });
  sheet.querySelector("#uid-method")!.addEventListener("click", ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-m]");
    if (!btn) return;
    method = btn.dataset.m as Method;
    sheet.querySelectorAll("#uid-method button").forEach(b => b.classList.toggle("active", b === btn));
    sheet.querySelector("#uid-steps")!.innerHTML = section(method === "ios" ? IOS_STEPS : ANDROID_STEPS);
  });

  document.body.appendChild(sheet);
}
