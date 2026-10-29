import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The control panel is served from 127.0.0.1:5175 and talks to the local API on 8040.
// The browser keeps the page and the API same-origin through the proxy; the API only trusts
// this origin when started with `devhub serve --dev-origin http://127.0.0.1:5175`.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    proxy: {
      "/api": { target: "http://127.0.0.1:8040", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
