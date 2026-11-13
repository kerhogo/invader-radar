import { readdirSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";

// base "./" : l'app fonctionne servie depuis un sous-chemin GitHub Pages
// (https://<user>.github.io/invader-radar/) comme depuis la racine.
export default defineConfig({
  base: "./",
  plugins: [{
    // Liste des fichiers du build, lue par le service worker (public/sw.js) : il ne range une
    // page dans son cache qu'avec tous ses fichiers, pour qu'elle s'ouvre toujours hors ligne.
    name: "assets-list",
    apply: "build",
    closeBundle() {
      writeFileSync("dist/assets.json", JSON.stringify(readdirSync("dist/assets").sort()));
    }
  }],
  build: {
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"]
        }
      }
    }
  }
});
