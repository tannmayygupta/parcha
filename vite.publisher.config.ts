import { defineConfig } from "vite";

/**
 * The publisher is a static app too. `base: './'` keeps all URLs relative, so it can be uploaded
 * to Swarm exactly like the reader (scripts/deploy-publisher.ts): the newsroom's tool is then as
 * hard to take down as its site.
 */
export default defineConfig({
  root: "src/publisher",
  base: "./",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
