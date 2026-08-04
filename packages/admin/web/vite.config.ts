import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The operator's SPA. It is served **same-origin with its own admin API** — in
 * dev by proxying `/api` here, in production by whatever fronts the admin
 * service — because the session is an httpOnly `SameSite=Strict` cookie, which
 * only works if the panel and the API are one origin (ADR 0010).
 *
 * A different port from the Client SPA (5174 vs 5173), pointed at a different
 * API (3002 vs 3001): the two are independent deployables, and nothing about
 * running one should require the other.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:3002", changeOrigin: false },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
  },
});
