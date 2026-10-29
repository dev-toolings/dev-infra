import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The control panel is served from 127.0.0.1:5175 and talks to the local API (8040, or the
// port `devhub serve --dev` passes in DEVHUB_API_PORT). The browser keeps the page and the API
// same-origin through the proxy; the API only trusts this origin in development mode.
const apiPort = Number(process.env.DEVHUB_API_PORT ?? 8040);
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
