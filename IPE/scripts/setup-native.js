#!/usr/bin/env node
/**
 * Rebuild the native modules that Theia ships, after patch-package has
 * applied any source-level patches. Splits npm rebuild per-module so a
 * failure on one module doesn't stop the rest.
 *
 * Reads `.npmrc` from this directory; we rely on `clang=false` there to
 * make node-gyp fall back to MSVC (the user has v143 but not the ClangCL
 * MSBuild toolset that Node 24 picks by default).
 */

const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");

const projectRoot = path.resolve(__dirname, "..");
const modules = [
  "drivelist",
  "keytar",
  "node-pty",
  "nsfw",
  "msgpackr-extract",
  "@vscode/windows-ca-certs",
];

let failed = 0;
for (const mod of modules) {
  const modPath = path.join(projectRoot, "node_modules", mod);
  if (!fs.existsSync(modPath)) {
    console.log(`[setup-native] ${mod} not installed; skipping.`);
    continue;
  }

  process.stdout.write(`[setup-native] Rebuilding ${mod}... `);
  const result = spawnSync(
    "npm",
    ["rebuild", mod, "--foreground-scripts"],
    {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    }
  );

  if (result.status === 0) {
    console.log("ok");
  } else {
    failed++;
    console.log("FAILED");
    process.stdout.write(result.stdout?.toString() ?? "");
    process.stderr.write(result.stderr?.toString() ?? "");
  }
}

if (failed > 0) {
  console.error(`\n[setup-native] ${failed} module(s) failed to rebuild.`);
  process.exit(1);
}
console.log("[setup-native] All native modules rebuilt.");

// `yarn install --ignore-scripts` skips postinstall hooks. A few packages
// (notably @vscode/ripgrep) use postinstall to *download* a prebuilt binary
// rather than to invoke node-gyp, so it's safe to run those after the
// MSVC-only rebuild step has finished. Add new download-only postinstalls
// here as we hit them.
const postinstallTargets = [
  { module: "@vscode/ripgrep", script: "lib/postinstall.js", artifact: "bin/rg.exe" },
];

for (const { module: mod, script, artifact } of postinstallTargets) {
  const modPath = path.join(projectRoot, "node_modules", mod);
  if (!fs.existsSync(modPath)) {
    console.log(`[setup-native] ${mod} not installed; skipping postinstall.`);
    continue;
  }
  if (artifact && fs.existsSync(path.join(modPath, artifact))) {
    console.log(`[setup-native] ${mod} ${artifact} already present; skipping postinstall.`);
    continue;
  }

  process.stdout.write(`[setup-native] Running postinstall for ${mod}... `);
  const result = spawnSync("node", [script], {
    cwd: modPath,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) {
    console.log("ok");
  } else {
    console.log("FAILED");
    process.stdout.write(result.stdout?.toString() ?? "");
    process.stderr.write(result.stderr?.toString() ?? "");
    process.exit(1);
  }
}
