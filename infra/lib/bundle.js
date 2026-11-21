// Bundle one Lambda handler (and everything it imports, AWS SDK included, so
// the code never depends on the runtime's bundled SDK version) into a zip.

import { build } from "esbuild";
import { zipSync } from "fflate";

export async function bundleHandler(entry) {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    legalComments: "none",
    logLevel: "warning",
    // Lets bundled CommonJS dependencies require Node built-ins from ESM.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const code = outputFiles[0].contents;
  return { zip: zipSync({ "index.mjs": code }, { level: 9 }), bytes: code.length };
}
