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

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const entries = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function resolvePathFromProject(inputPath, fallbackPath) {
  const targetPath = inputPath || fallbackPath;
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(projectDir, targetPath);
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
    path.join(projectDir, "nginx", "ssl"),
  ];

  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return env;
}

function getWorkspaceMount(env) {
  const hostWorkspace = (env.HOST_WORKSPACE || "").trim();

  if (!hostWorkspace || hostWorkspace === "./workspace") {
    return repoRoot;
  }

  return resolvePathFromProject(hostWorkspace, "./workspace");
}

function getDockerCommand() {
  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0) {
    return {
      command: "docker",
      composeArgs: ["compose"],
    };
  }

  if (spawnSync("docker-compose", ["version"], { stdio: "ignore" }).status === 0) {
    return {
      command: "docker-compose",
      composeArgs: [],
    };
  }

  fail("Docker Compose was not found. Install Docker Desktop or docker-compose first.");
}

function buildComposeArgs(docker, extraArgs) {
  return [
    ...docker.composeArgs,
    "-f",
    path.join(projectDir, "docker-compose.yml"),
    ...extraArgs,
  ];
}

function runCompose(extraArgs) {
  const docker = getDockerCommand();
  const env = parseEnvFile(envPath);
  const result = spawnSync(
    docker.command,
    buildComposeArgs(docker, extraArgs),
    {
      cwd: projectDir,
      env: {
        ...process.env,
        HOST_WORKSPACE: getWorkspaceMount(env),
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    fail(result.error.message);
  }

  process.exit(result.status ?? 1);
}

function checkModelAvailability(env) {
  const backend = (env.LLM_BACKEND || "llamacpp").trim();

  if (backend === "vllm") {
    return;
  }

  const modelsDir = resolvePathFromProject(env.MODELS_DIR, "./models");
  const configuredModel = env.GEMMA_MODEL || "gemma-4-12b-it-Q4_K_M.gguf";
  const configuredModelPath = path.join(modelsDir, configuredModel);
  const availableModels = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir).filter((file) => file.toLowerCase().endsWith(".gguf"))
    : [];

  if (fs.existsSync(configuredModelPath) || availableModels.length > 0) {
    return;
  }

  fail(
    [
      "No local GGUF model was found for llama.cpp startup.",
      `Expected ${configuredModelPath}`,
      "Add a model file under IPE/models, or update IPE/.env with MODELS_DIR and GEMMA_MODEL, or switch LLM_BACKEND=vllm before running npm start.",
    ].join("\n"),
  );
}

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();

  for (const networkInterface of Object.values(interfaces)) {
    if (!networkInterface) {
      continue;
    }

    for (const entry of networkInterface) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "localhost";
}

function waitForIde(port, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          timeout: 3000,
        },
        (response) => {
          response.resume();
          resolve();
        },
      );

      request.on("timeout", () => {
        request.destroy();
      });

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

async function startProject() {
  const env = ensureProjectFiles();
  checkModelAvailability(env);
  const workspaceMount = getWorkspaceMount(env);

  const docker = getDockerCommand();
  const upResult = spawnSync(
    docker.command,
    buildComposeArgs(docker, ["up", "-d"]),
    {
      cwd: projectDir,
      env: {
        ...process.env,
        HOST_WORKSPACE: workspaceMount,
      },
      stdio: "inherit",
    },
  );

  if (upResult.error) {
    fail(upResult.error.message);
  }

  if (upResult.status !== 0) {
    process.exit(upResult.status ?? 1);
  }

  const idePort = Number.parseInt(env.IDE_PORT || "3000", 10);
  log(`Waiting for the IDE on http://localhost:${idePort} ...`);

  try {
    await waitForIde(idePort, 120000);
  } catch (error) {
    fail(
      [
        error.message,
        "The containers were started, but the IDE is not reachable yet.",
        "Check logs with npm run logs.",
      ].join("\n"),
    );
  }

  log("");
  log("Gemma Theia IDE is running.");
  log(`Desktop: http://localhost:${idePort}`);
  log(`Mobile:  http://${getLocalIpAddress()}:${idePort}`);
  log(`Workspace: ${workspaceMount}`);
  log("Logs:    npm run logs");
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
      runCompose(["down"]);
      return;
    case "logs": {
      const docker = getDockerCommand();
      const child = spawn(
        docker.command,
        buildComposeArgs(docker, ["logs", "-f"]),
        {
          cwd: projectDir,
          env: {
            ...process.env,
            HOST_WORKSPACE: getWorkspaceMount(parseEnvFile(envPath)),
          },
          stdio: "inherit",
        },
      );

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
      return;
    }
    default:
      fail(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  fail(error.message);
});
