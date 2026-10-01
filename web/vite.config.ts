import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;
const frontend = resolve(here, "../frontend/src");
const frontendApi = resolve(frontend, "api.ts");
const webApi = resolve(here, "src/api.ts");

/**
 * The static build of Sortify, for GitHub Pages.
 *
 * It is the very same React app as `frontend/`, with one module swapped: `frontend/src/api.ts`
 * normally talks to `sortify ui` over HTTP, and here it is replaced by `web/src/api.ts`, which
 * runs the same domain code in the page. Nothing in `frontend/` or `backend/` is modified.
 *
 * Nothing from the environment is inlined into the bundle: keys are entered in the running app
 * and kept in the browser, so a build can never carry a secret into published JavaScript.
 *
 * Every backend module the pipeline reaches is free of runtime `node:` imports, so no stubbing
 * is needed; adding one would break this build.
 *
 * Set SORTIFY_BASE to the path the site is served from — for a project page that is the repo
 * name, e.g. `/Sortify/`. It defaults to `/` for a user site or a custom domain.
 */
export default defineConfig({
  root: here,
  base: process.env.SORTIFY_BASE ?? "/",
  plugins: [
    react(),
    {
      /*
       * Swap the HTTP client for the in-page one.
       *
       * This resolves the import rather than matching its text: the app writes `./api.ts` and
       * `../api.ts`, so a path alias would never fire. Anything that resolves to
       * frontend/src/api.ts is redirected, wherever it was imported from.
       */
      name: "sortify-api-swap",
      enforce: "pre",
      resolveId(source: string, importer: string | undefined) {
        if (!importer || !source.startsWith(".")) return null;
        const from = dirname(importer.split("?")[0] ?? importer);
        return resolve(from, source) === frontendApi ? webApi : null;
      },
    },
    {
      /*
       * Fail the build on a `node:` import from our own code.
       *
       * Vite otherwise externalises builtins silently and the page throws only when the binding
       * is touched — far from the import that caused it. Any backend module the pipeline reaches
       * has to work in both shells, so this turns that rule into a build error naming the file.
       */
      name: "sortify-no-node-builtins",
      enforce: "pre",
      resolveId(source: string, importer: string | undefined) {
        if (!source.startsWith("node:") || !importer || importer.includes("node_modules")) {
          return null;
        }
        throw new Error(
          `${importer} imports ${source}, which the browser build cannot load. Move the part ` +
            "that needs it into a module only the Node shells import.",
        );
      },
    },
    {
      // GitHub Pages serves 404.html for any path it does not recognise. Making it a copy of
      // index.html is what lets a deep link like /runs/2 load the app instead of an error page.
      name: "sortify-spa-fallback",
      closeBundle() {
        const dist = resolve(here, "dist");
        copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
      },
    },
  ],
});
