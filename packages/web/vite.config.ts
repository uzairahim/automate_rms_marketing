import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA talks to the Fastify API. In dev, /api is proxied to the API process
// so the browser hits a single origin (mirrors the nginx setup in production).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
