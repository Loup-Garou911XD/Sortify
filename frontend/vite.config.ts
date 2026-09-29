import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds to frontend/dist, which `sortify ui` (backend) serves. In development, API calls are
// proxied to `sortify ui` on port 4747, so run `npm run dev:backend` too (Ctrl+Shift+B in
// VS Code starts both).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:4747" },
  },
});
