// Bundles the server into dist/server.mjs (dependencies stay in node_modules).
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
  // `npm start` runs in production mode on every OS (no NODE_ENV=… syntax needed on Windows).
  banner: { js: "process.env.NODE_ENV ??= 'production';" },
});
