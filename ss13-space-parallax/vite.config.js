import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs are required because GitHub Pages serves this repo
  // from /Larp-Station-13/ rather than the domain root.
  base: "./",
  build: {
    rollupOptions: {
      input: {
        settings: "index.html",
        background: "background.html",
      },
    },
  },
});