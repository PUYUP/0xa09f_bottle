import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Shared E2EE/crypto/store layer — single source of truth with the
      // web frontend. Pure Web Platform APIs (WebCrypto, IndexedDB, fetch).
      "@shared": fileURLToPath(new URL("../frontend/src/lib", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [".."] },
  },
});
