import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA talks to the Fastify API. In dev, /api is proxied to the API process
// so the browser hits a single origin (mirrors the nginx setup in production).
export default defineConfig({
  plugins: [react()],
  server: {
    // Every Client subdomain resolves to 127.0.0.1, so `acme.localhost:5173`
    // reaches this server — which is what makes per-Client tenancy work in dev.
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        // Deliberately NOT changeOrigin: the API derives the tenant from the Host
        // header, so rewriting it to `localhost:3001` makes every request arrive
        // as an unknown Client (404). Forwarding the browser's own Host is what
        // lets `acme.localhost:5173` be recognized as the Acme Client — and it is
        // what nginx does in production too.
        changeOrigin: false,
      },
    },
  },
});
