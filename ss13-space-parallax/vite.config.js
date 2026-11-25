import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  build: {
    rollupOptions: {
      input: {
        settings: "index.html",
        background: "background.html",
      },
    },
  },
});