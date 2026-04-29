#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const httpProxy = require("http-proxy");

const repoRoot = path.resolve(__dirname, "..");
const projectDir = path.join(repoRoot, "IPE");
const envExamplePath = path.join(projectDir, ".env.example");
const envPath = path.join(projectDir, ".env");

const components = {
  ide: {
    label: "Local Theia IDE",
    pidFile: path.join(projectDir, ".local-ide.pid"),
    logFile: path.join(projectDir, ".local-ide.log"),
  },
  llm: {
    label: "LLM server",
    pidFile: path.join(projectDir, ".llm-server.pid"),
    logFile: path.join(projectDir, ".llm-server.log"),
  },
  telegram: {
    label: "Telegram bridge",
    pidFile: path.join(projectDir, ".telegram.pid"),
    logFile: path.join(projectDir, ".telegram.log"),
  },
};

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

function isTruthy(value) {
  if (value === undefined || value === null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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

function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readPid(pidFile) {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function reconcilePid(component, port) {
  const pid = readPid(component.pidFile);
  if (pid === null) return null;

  const pidAlive = isPidLive(pid);
  const portAlive = port ? await probePort(port) : pidAlive;

  if (pidAlive && portAlive) return pid;

  fs.rmSync(component.pidFile, { force: true });
  return null;
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_error) {
      // Process already gone — nothing to do.
    }
  }
}

function stopComponent(component) {
  const pid = readPid(component.pidFile);
  if (pid === null) {
    fs.rmSync(component.pidFile, { force: true });
    return false;
  }
  fs.rmSync(component.pidFile, { force: true });
  killPid(pid);
  return true;
}

function waitForHttp(port, timeoutMs, urlPath = "/") {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(
        { host: "127.0.0.1", port, path: urlPath, timeout: 3000 },
        (response) => {
          response.resume();
          resolve();
        }
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for http://127.0.0.1:${port}${urlPath}`));
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

async function startDetachedLocalIde(env, workspaceMount) {
  const publicPort = Number.parseInt(env.IDE_PORT || "3000", 10);
  const idePort = publicPort + 1;

  const livePid = await reconcilePid(components.ide, idePort);
  if (livePid !== null) {
    log(`A local IDE process is already running (PID ${livePid}). Reusing it.`);
    return { publicPort, idePort, reused: true };
  }

  const logFd = fs.openSync(components.ide.logFile, "a");
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
  fs.writeFileSync(components.ide.pidFile, String(child.pid));
  child.unref();

  return { publicPort, idePort, reused: false };
}

function llmServerPort(env) {
  return Number.parseInt(env.LLM_SERVER_PORT || "8000", 10);
}

async function startDetachedLlmServer(env, workspaceMount) {
  if (!isTruthy(env.START_LLM_SERVER ?? "true")) {
    log("LLM server auto-start disabled (START_LLM_SERVER=false). Skipping.");
    return null;
  }

  const port = llmServerPort(env);
  const livePid = await reconcilePid(components.llm, port);
  if (livePid !== null) {
    log(`LLM server already running (PID ${livePid}). Reusing it.`);
    return { port, reused: true };
  }

  const logFd = fs.openSync(components.llm.logFile, "a");
  let child;

  const llmServerDir = path.join(projectDir, "llm-server");
  const venvPython =
    process.platform === "win32"
      ? path.join(llmServerDir, ".venv", "Scripts", "python.exe")
      : path.join(llmServerDir, ".venv", "bin", "python");

  if (process.platform === "win32") {
    if (fs.existsSync(venvPython)) {
      // Skip the PowerShell wrapper once the venv exists — running python
      // directly with -u gives us live, unbuffered logs and a stable PID.
      child = spawn(
        venvPython,
        ["-u", path.join(llmServerDir, "server.py")],
        {
          cwd: llmServerDir,
          detached: true,
          env: {
            ...process.env,
            CONFIG_PATH: path.join(llmServerDir, "config.yaml"),
            ENV_FILE: envPath,
            PROJECT_DIR: repoRoot,
            PSC_TARGET_WORKSPACE: resolvePathFromProject(env.PSC_TARGET_WORKSPACE, workspaceMount),
            PYTHONUNBUFFERED: "1",
          },
          stdio: ["ignore", logFd, logFd],
        }
      );
    } else {
      // First-run path: PowerShell creates the venv and installs deps.
      const startScript = path.join(repoRoot, "scripts", "start-llm.ps1");
      if (!fs.existsSync(startScript)) {
        fs.closeSync(logFd);
        fail(`Cannot start LLM server — script not found at ${startScript}`);
      }
      child = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", startScript],
        {
          cwd: repoRoot,
          detached: true,
          env: process.env,
          stdio: ["ignore", logFd, logFd],
        }
      );
    }
  } else {
    log("LLM auto-start currently only supports Windows (start-llm.ps1). Run the Python server manually on this platform.");
    fs.closeSync(logFd);
    return null;
  }

  fs.closeSync(logFd);
  fs.writeFileSync(components.llm.pidFile, String(child.pid));
  child.unref();

  return { port, reused: false };
}

function telegramBridgeReady(env) {
  return Boolean((env.TELEGRAM_BOT_TOKEN || "").trim());
}

function pythonExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(projectDir, "llm-server", ".venv", "Scripts", "python.exe"),
          "python.exe",
          "python",
        ]
      : [
          path.join(projectDir, "llm-server", ".venv", "bin", "python"),
          "python3",
          "python",
        ];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else if (commandExists(candidate, ["--version"])) {
      return candidate;
    }
  }
  return null;
}

async function startDetachedTelegramBridge(env, llmPort) {
  if (!telegramBridgeReady(env)) {
    log("Telegram bridge skipped (TELEGRAM_BOT_TOKEN not set in IPE/.env).");
    return null;
  }

  const livePid = await reconcilePid(components.telegram);
  if (livePid !== null) {
    log(`Telegram bridge already running (PID ${livePid}). Reusing it.`);
    return { reused: true };
  }

  const python = pythonExecutable();
  if (!python) {
    log("Telegram bridge skipped — could not locate python interpreter. Run `npm start` once first to create the venv.");
    return null;
  }

  const bridgeScript = path.join(projectDir, "llm-server", "telegram_bridge.py");
  if (!fs.existsSync(bridgeScript)) {
    log(`Telegram bridge skipped — script missing at ${bridgeScript}.`);
    return null;
  }

  const logFd = fs.openSync(components.telegram.logFile, "a");
  const child = spawn(python, [bridgeScript], {
    cwd: path.join(projectDir, "llm-server"),
    detached: true,
    env: {
      ...process.env,
      LLM_SERVER_URL: env.LLM_SERVER_URL || `http://127.0.0.1:${llmPort}`,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || "",
      TELEGRAM_ALLOWED_CHAT_IDS: env.TELEGRAM_ALLOWED_CHAT_IDS || "",
      TELEGRAM_DEFAULT_MODE: env.TELEGRAM_DEFAULT_MODE || "chat",
    },
    stdio: ["ignore", logFd, logFd],
  });

  fs.closeSync(logFd);
  fs.writeFileSync(components.telegram.pidFile, String(child.pid));
  child.unref();
  return { reused: false };
}

function showLogs(component) {
  if (!fs.existsSync(component.logFile)) {
    fail(`No log file found at ${component.logFile}.`);
  }
  if (process.platform === "win32") {
    const child = spawn(
      "powershell",
      ["-NoLogo", "-NoProfile", "-Command", `Get-Content -Path '${component.logFile}' -Wait`],
      { stdio: "inherit" }
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const child = spawn("tail", ["-f", component.logFile], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
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
  const { publicPort, idePort } = await startDetachedLocalIde(env, workspaceMount);
  log(`Waiting for the IDE on http://localhost:${idePort} ...`);

  try {
    await waitForHttp(idePort, 120000);
  } catch (error) {
    fail(
      [
        error.message,
        "The local IDE process was started, but the browser UI is not reachable yet.",
        `Check logs in ${path.relative(repoRoot, components.ide.logFile)} or run npm run logs.`,
      ].join("\n")
    );
  }

  const llmStart = await startDetachedLlmServer(env, workspaceMount);
  if (llmStart) {
    log(`Waiting for LLM server on http://localhost:${llmStart.port}/health ...`);
    try {
      await waitForHttp(llmStart.port, 180000, "/health");
      log("LLM server is up.");
    } catch (error) {
      log(`LLM server did not respond in time: ${error.message}`);
      log(`Check logs in ${path.relative(repoRoot, components.llm.logFile)} or run npm run logs:llm.`);
    }
  }

  const telegram = await startDetachedTelegramBridge(env, llmStart ? llmStart.port : llmServerPort(env));
  if (telegram && !telegram.reused) {
    log("Telegram bridge launched. Send /start to your bot to test.");
  }

  log(`Starting local CORS proxy on port ${publicPort}...`);
  if (process.platform === "win32") {
    try {
      spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process -Id (Get-NetTCPConnection -LocalPort ${publicPort} -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force`]);
    } catch (_error) {
      // Best-effort cleanup; ignore.
    }
  } else {
    try {
      spawnSync("sh", ["-c", `lsof -t -i:${publicPort} | xargs kill -9`]);
    } catch (_error) {
      // Best-effort cleanup; ignore.
    }
  }

  const llmTarget = `http://127.0.0.1:${llmStart ? llmStart.port : llmServerPort(env)}`;
  const ideTarget = `http://127.0.0.1:${idePort}`;

  // Routes that belong to the LLM FastAPI server. Everything else (including
  // any other /api/* path Theia exposes) goes to Theia. Add new LLM routes
  // here as the Python server grows.
  const llmPathPrefixes = [
    "/api/chat",
    "/api/complete",
    "/api/terminal",
    "/api/execute",
    "/api/workspace",
    "/api/refactor",
    "/api/explain",
    "/api/setup/",
    "/api/ollama/",
    "/api/fs/",
  ];
  const isLlmRoute = (url) => {
    if (!url) return false;
    const path = url.split("?", 1)[0];
    if (path === "/health") return true;
    return llmPathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
  };

  const proxy = httpProxy.createProxyServer({ ws: true });
  proxy.on("error", (err, req, res) => {
    if (!res || !res.writeHead) return;
    const upstreamLabel = req && isLlmRoute(req.url) ? "LLM server" : "Theia";
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": (req && req.headers && req.headers.origin) || "*",
      "Access-Control-Allow-Credentials": "true",
    });
    res.end(
      JSON.stringify({
        error: `${upstreamLabel} is not reachable`,
        detail: err.message,
        upstream: upstreamLabel,
      })
    );
  });

  const setCorsHeaders = (req, res) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type, Authorization, X-Requested-With"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  const server = http.createServer((req, res) => {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const target = isLlmRoute(req.url) ? llmTarget : ideTarget;
    proxy.web(req, res, { target });
  });

  server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head, { target: ideTarget });
  });

  server.listen(publicPort, "0.0.0.0");

  log("");
  log("Gemma Theia IDE is running natively.");
  log(`Desktop: http://localhost:${publicPort}`);
  log(`Mobile:  http://${getLocalIpAddress()}:${publicPort}`);
  log(`Workspace: ${workspaceMount}`);
  log(`Logs:    npm run logs (IDE) | npm run logs:llm | npm run logs:telegram`);
  log("Stop:    npm run stop");

  spawnDesktopWindow(env, publicPort);

  log("Proxy is running in the foreground. Press Ctrl+C to stop the proxy (background services keep running).");
}

function findChromiumBrowser() {
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  } else if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } else if (process.platform === "linux") {
    const which = (cmd) => spawnSync("which", [cmd]).stdout.toString().trim();
    for (const cmd of ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"]) {
      const found = which(cmd);
      if (found) return found;
    }
  }
  return null;
}

function spawnDesktopWindow(env, publicPort) {
  if (!isTruthy(env.OPEN_WINDOW ?? "true")) {
    log("Desktop window auto-launch disabled (OPEN_WINDOW=false).");
    return;
  }

  const url = `http://localhost:${publicPort}/`;
  const browser = findChromiumBrowser();

  if (browser) {
    const userDataDir = path.join(projectDir, ".window-profile");
    fs.mkdirSync(userDataDir, { recursive: true });
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1400,900",
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    log(`Desktop window opened via ${path.basename(browser)}. Close any time; services keep running.`);
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    log(`Opened ${url} in your default browser (no Chromium-based browser found for app-mode window).`);
    return;
  }

  log(`Open ${url} in a browser — no auto-launcher available for this platform.`);
}

async function openWindow() {
  const env = ensureProjectFiles();
  const publicPort = Number.parseInt(env.IDE_PORT || "3000", 10);

  log(`Checking that the IDE is reachable on http://localhost:${publicPort} ...`);
  try {
    await waitForHttp(publicPort, 5000);
  } catch (_error) {
    fail(
      [
        `The IDE is not reachable on http://localhost:${publicPort}.`,
        "Run `npm start` first to launch the Theia backend and proxy, then run `npm run window` in another terminal.",
      ].join("\n")
    );
  }

  spawnDesktopWindow({ ...env, OPEN_WINDOW: "true" }, publicPort);
}

function stopAll() {
  let stoppedAny = false;
  for (const key of ["telegram", "llm", "ide"]) {
    const component = components[key];
    if (stopComponent(component)) {
      log(`Stopped ${component.label}.`);
      stoppedAny = true;
    }
  }
  if (!stoppedAny) {
    log("No background services were running.");
  }
}

async function bootstrapIPE() {
  log("Running `yarn install --ignore-scripts` in IPE (auto-rebuilds disabled)...");
  let result = spawnSync("corepack", ["yarn", "install", "--ignore-scripts"], {
    cwd: projectDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail("yarn install failed.");
  }

  log("Applying patch-package patches...");
  result = spawnSync("npx", ["patch-package"], {
    cwd: projectDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail("patch-package failed.");
  }

  log("Rebuilding native modules with MSVC toolset...");
  result = spawnSync("node", [path.join(projectDir, "scripts", "setup-native.js")], {
    cwd: projectDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    fail("Native module rebuild failed.");
  }

  log("");
  log("IPE bootstrapped. Run `npm start` to launch.");
}

async function main() {
  const command = process.argv[2] || "start";
  switch (command) {
    case "setup":
      ensureProjectFiles();
      log("Project bootstrap files are ready.");
      return;
    case "bootstrap":
      await bootstrapIPE();
      return;
    case "start":
      await startProject();
      return;
    case "stop":
      stopAll();
      return;
    case "logs":
      showLogs(components.ide);
      return;
    case "logs:llm":
      showLogs(components.llm);
      return;
    case "logs:telegram":
      showLogs(components.telegram);
      return;
    case "window":
      await openWindow();
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  fail(error.message);
});
