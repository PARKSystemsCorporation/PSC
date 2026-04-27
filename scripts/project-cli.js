#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const projectDir = path.join(repoRoot, "IPE");
const envExamplePath = path.join(projectDir, ".env.example");
const envPath = path.join(projectDir, ".env");
const localIdePidPath = path.join(projectDir, ".local-ide.pid");
const localIdeLogPath = path.join(projectDir, ".local-ide.log");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function commandExists(command, args) {
  return spawnSync(command, args, {
    shell: process.platform === "win32" && command === "npm",
    stdio: "ignore",
  }).status === 0;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const entries = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

function resolvePathFromProject(inputPath, fallbackPath) {
  const targetPath = inputPath || fallbackPath;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(projectDir, targetPath);
}

function ensureProjectFiles() {
  if (!fs.existsSync(projectDir)) {
    fail(`Expected project directory at ${projectDir}`);
  }
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
    log(`Created ${path.relative(repoRoot, envPath)} from .env.example`);
  }
  const env = parseEnvFile(envPath);
  const directories = [
    resolvePathFromProject(env.MODELS_DIR, "./models"),
    resolvePathFromProject(env.HOST_WORKSPACE, "./workspace"),
    path.dirname(resolvePathFromProject(env.MEMPALACE_PALACE_PATH, "./.mempalace/palace")),
  ];
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return env;
}

function getWorkspaceMount(env) {
  const hostWorkspace = (env.HOST_WORKSPACE || "").trim();
  if (!hostWorkspace || hostWorkspace === "./workspace") return repoRoot;
  return resolvePathFromProject(hostWorkspace, "./workspace");
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const networkInterface of Object.values(interfaces)) {
    if (!networkInterface) continue;
    for (const entry of networkInterface) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

function waitForIde(port, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 3000 },
        (response) => {
          response.resume();
          resolve();
        }
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for http://localhost:${port}`));
          return;
        }
        setTimeout(attempt, 2000);
      });
    };
    attempt();
  });
}

function localIdeDependenciesReady() {
  return (
    fs.existsSync(path.join(projectDir, "node_modules")) &&
    fs.existsSync(path.join(projectDir, "applications", "browser", "src-gen", "backend", "main.js"))
  );
}

function canLaunchLocalIde() {
  return (
    localIdeDependenciesReady() &&
    commandExists("npm", ["exec", "--prefix", projectDir, "theia", "--", "--version"])
  );
}

function startDetachedLocalIde(env, workspaceMount) {
  const idePort = Number.parseInt(env.IDE_PORT || "3000", 10);
  if (fs.existsSync(localIdePidPath)) {
    const existingPid = Number.parseInt(fs.readFileSync(localIdePidPath, "utf8").trim(), 10);
    if (Number.isInteger(existingPid) && existingPid > 0) {
      try {
        process.kill(existingPid, 0);
        log(`A local IDE process is already recorded (PID ${existingPid}). Reusing it.`);
        return idePort;
      } catch (_error) {
        fs.rmSync(localIdePidPath, { force: true });
      }
    } else {
      fs.rmSync(localIdePidPath, { force: true });
    }
  }

  const logFd = fs.openSync(localIdeLogPath, "a");
  const child = spawn(
    "npm",
    [
      "exec",
      "--prefix",
      projectDir,
      "theia",
      "--",
      "start",
      "--hostname=0.0.0.0",
      `--port=${idePort}`,
      "--plugins=local-dir:../../plugins",
      workspaceMount,
    ],
    {
      cwd: path.join(projectDir, "applications", "browser"),
      detached: true,
      env: {
        ...process.env,
        HOST_WORKSPACE: workspaceMount,
      },
      shell: process.platform === "win32",
      stdio: ["ignore", logFd, logFd],
    }
  );

  fs.closeSync(logFd);
  fs.writeFileSync(localIdePidPath, String(child.pid));
  child.unref();

  return idePort;
}

function stopLocalIde() {
  if (!fs.existsSync(localIdePidPath)) {
    return false;
  }
  const pid = Number.parseInt(fs.readFileSync(localIdePidPath, "utf8").trim(), 10);
  fs.rmSync(localIdePidPath, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return true;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_error) {
      return true;
    }
  }
  return true;
}

function showLocalIdeLogs() {
  if (!fs.existsSync(localIdeLogPath)) {
    fail("No local IDE log file was found yet.");
  }
  if (process.platform === "win32") {
    const child = spawn(
      "powershell",
      ["-NoLogo", "-NoProfile", "-Command", `Get-Content -Path '${localIdeLogPath}' -Wait`],
      { stdio: "inherit" }
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    return true;
  }
  const child = spawn("tail", ["-f", localIdeLogPath], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  return true;
}

async function startProject() {
  const env = ensureProjectFiles();
  const workspaceMount = getWorkspaceMount(env);

  if (!canLaunchLocalIde()) {
    const windowsBuildToolsNote = process.platform === "win32"
      ? 'On Windows, local Theia bootstrap needs Visual Studio Build Tools with the "Desktop development with C++" workload.'
      : null;
    fail(
      [
        "The repo is not bootstrapped for the local IDE yet.",
        "Run `corepack yarn install` inside `IPE` and build native dependencies, then run `npm start` again.",
        windowsBuildToolsNote,
      ].filter(Boolean).join("\n")
    );
  }

  log("Starting local Theia IDE process...");
  const idePort = startDetachedLocalIde(env, workspaceMount);
  log(`Waiting for the IDE on http://localhost:${idePort} ...`);

  try {
    await waitForIde(idePort, 120000);
  } catch (error) {
    fail(
      [
        error.message,
        "The local IDE process was started, but the browser UI is not reachable yet.",
        `Check logs in ${path.relative(repoRoot, localIdeLogPath)} or run npm run logs.`,
      ].join("\n")
    );
  }

  log("");
  log("Gemma Theia IDE is running natively.");
  log(`Desktop: http://localhost:${idePort}`);
  log(`Mobile:  http://${getLocalIpAddress()}:${idePort}`);
  log(`Workspace: ${workspaceMount}`);
  log(`Logs:    npm run logs (${path.relative(repoRoot, localIdeLogPath)})`);
  log("Stop:    npm run stop");
}

async function main() {
  const command = process.argv[2] || "start";
  switch (command) {
    case "setup":
      ensureProjectFiles();
      log("Project bootstrap files are ready.");
      return;
    case "start":
      await startProject();
      return;
    case "stop":
      if (stopLocalIde()) {
        log("Stopped the local IDE process.");
      } else {
        log("No local IDE process is currently running.");
      }
      return;
    case "logs":
      showLocalIdeLogs();
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  fail(error.message);
});
