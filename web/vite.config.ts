import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev:web` serves the UI with hot reload and proxies API calls to `sortify ui`
// (start it with `npm run sortify -- ui` in another terminal).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:4747" },
  },
});
