import { defineConfig } from "vite";

/**
 * Builds the reader site (the page readers open). `base: './'` keeps every URL relative so the
 * same build works under any gateway, subdomain or base path. Output goes to dist-reader/, then
 * scripts/pack-reader.ts inlines it into the publisher as text.
 */
export default defineConfig({
  root: "src/reader",
  base: "./",
  build: {
    outDir: "../../dist-reader",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
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
