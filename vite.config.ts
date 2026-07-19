import { defineConfig } from "vite";

// base "./" : l'app fonctionne servie depuis un sous-chemin GitHub Pages
// (https://<user>.github.io/invader-radar/) comme depuis la racine.
export default defineConfig({
  base: "./",
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
