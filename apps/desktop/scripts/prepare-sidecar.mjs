import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.OPENWORK_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "src-tauri", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

// opencode 已被 tron-ai (npm) 替代，不再从 GitHub 下载
const opencodeRouterVersion = (() => {
  if (process.env.OPENCODE_ROUTER_VERSION?.trim()) return process.env.OPENCODE_ROUTER_VERSION.trim();
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.opencodeRouterVersion) return String(pkg.opencodeRouterVersion).trim();
  } catch {
    // ignore
  }
  return null;
})();
const chromeDevtoolsMcpVersion =
  process.env.CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  process.env.OPENWORK_CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  "0.17.0";

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    // Windows baseline artifacts intermittently fail to extract in CI
    // with Bun 1.3.6. Use the stable x64 target here for now.
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    case "aarch64-pc-windows-msvc":
      return "bun-windows-arm64";
    default:
      return null;
  }
})();


// openwork-server paths
const openworkServerBaseName = "openwork-server";
const openworkServerName = isWindowsTarget ? `${openworkServerBaseName}.exe` : openworkServerBaseName;
const openworkServerPath = join(sidecarDir, openworkServerName);
const openworkServerBuildName = bunTarget
  ? `${openworkServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : openworkServerName;
const openworkServerBuildPath = join(sidecarDir, openworkServerBuildName);
const openworkServerTargetTriple = resolvedTargetTriple;
const openworkServerTargetName = openworkServerTargetTriple
  ? `${openworkServerBaseName}-${openworkServerTargetTriple}${openworkServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const openworkServerTargetPath = openworkServerTargetName ? join(sidecarDir, openworkServerTargetName) : null;

const openworkServerDir = resolve(__dirname, "..", "..", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

// opencode-router paths
const opencodeRouterBaseName = "opencode-router";
const opencodeRouterName = isWindowsTarget ? `${opencodeRouterBaseName}.exe` : opencodeRouterBaseName;
const opencodeRouterPath = join(sidecarDir, opencodeRouterName);
const opencodeRouterBuildName = bunTarget
  ? `${opencodeRouterBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : opencodeRouterName;
const opencodeRouterBuildPath = join(sidecarDir, opencodeRouterBuildName);
const opencodeRouterTargetTriple = resolvedTargetTriple;
const opencodeRouterTargetName = opencodeRouterTargetTriple
  ? `${opencodeRouterBaseName}-${opencodeRouterTargetTriple}${opencodeRouterTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const opencodeRouterTargetPath = opencodeRouterTargetName ? join(sidecarDir, opencodeRouterTargetName) : null;
const opencodeRouterDir = resolve(__dirname, "..", "..", "opencode-router");

// orchestrator paths
const orchestratorBaseName = "openwork-orchestrator";
const orchestratorName =
  isWindowsTarget ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "orchestrator");

// chrome-devtools-mcp shim sidecar
const chromeDevtoolsBaseName = "chrome-devtools-mcp";
const chromeDevtoolsName = isWindowsTarget ? `${chromeDevtoolsBaseName}.exe` : chromeDevtoolsBaseName;
const chromeDevtoolsPath = join(sidecarDir, chromeDevtoolsName);
const chromeDevtoolsBuildName = bunTarget
  ? `${chromeDevtoolsBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : chromeDevtoolsName;
const chromeDevtoolsBuildPath = join(sidecarDir, chromeDevtoolsBuildName);
const chromeDevtoolsTargetTriple = resolvedTargetTriple;
const chromeDevtoolsTargetName = chromeDevtoolsTargetTriple
  ? `${chromeDevtoolsBaseName}-${chromeDevtoolsTargetTriple}${chromeDevtoolsTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const chromeDevtoolsTargetPath = chromeDevtoolsTargetName ? join(sidecarDir, chromeDevtoolsTargetName) : null;
const chromeDevtoolsShimPath = resolve(__dirname, "chrome-devtools-mcp-shim.ts");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const findOpenCodeRouterBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeRouterName}`) || file.endsWith(`\\${opencodeRouterName}`)) ??
    candidates.find((file) => file.endsWith("/opencode-router") || file.endsWith("\\opencodeRouter")) ??
    null
  );
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

const parseChecksum = (content, assetName) => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, name] = trimmed.split(/\s+/);
    if (name === assetName) return hash.toLowerCase();
    if (trimmed.endsWith(` ${assetName}`)) {
      return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  }
  return null;
};

let didBuildOpenworkServer = false;
const shouldBuildOpenworkServer =
  forceBuild || !existsSync(openworkServerBuildPath) || isStubBinary(openworkServerBuildPath);

if (shouldBuildOpenworkServer) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(openworkServerBuildPath)) {
    try {
      unlinkSync(openworkServerBuildPath);
    } catch {
      // ignore
    }
  }
  const openworkServerScript = resolveBuildScript(openworkServerDir);
  if (!existsSync(openworkServerScript)) {
    console.error(`OpenWork server build script not found at ${openworkServerScript}`);
    process.exit(1);
  }
  const openworkServerArgs = [openworkServerScript, "--outdir", sidecarDir, "--filename", "openwork-server"];
  if (bunTarget) {
    openworkServerArgs.push("--target", bunTarget);
  }
  const buildResult = spawnSync("bun", openworkServerArgs, {
    cwd: openworkServerDir,
    stdio: "inherit",
    shell: true,
  });

  if (buildResult.status !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  didBuildOpenworkServer = true;
}

if (existsSync(openworkServerBuildPath)) {
  const shouldCopyCanonical = didBuildOpenworkServer || !existsSync(openworkServerPath) || isStubBinary(openworkServerPath);
  if (shouldCopyCanonical && openworkServerBuildPath !== openworkServerPath) {
    try {
      if (existsSync(openworkServerPath)) {
        unlinkSync(openworkServerPath);
      }
    } catch {
      // ignore
    }
    copyFileSync(openworkServerBuildPath, openworkServerPath);
  }

  if (openworkServerTargetPath) {
    const shouldCopyTarget =
      didBuildOpenworkServer || !existsSync(openworkServerTargetPath) || isStubBinary(openworkServerTargetPath);
    if (shouldCopyTarget && openworkServerBuildPath !== openworkServerTargetPath) {
      try {
        if (existsSync(openworkServerTargetPath)) {
          unlinkSync(openworkServerTargetPath);
        }
      } catch {
        // ignore
      }
      copyFileSync(openworkServerBuildPath, openworkServerTargetPath);
    }
  }
}

// opencode sidecar 下载已移除 — 由 tron-ai npm 包替代

// Build opencode-router sidecar
const opencodeRouterPkgRaw = readFileSync(resolve(opencodeRouterDir, "package.json"), "utf8");
const opencodeRouterPkg = JSON.parse(opencodeRouterPkgRaw);
const opencodeRouterPkgVersion = String(opencodeRouterPkg.version ?? "").trim();
const normalizedOpenCodeRouterVersion = opencodeRouterVersion?.startsWith("v")
  ? opencodeRouterVersion.slice(1)
  : opencodeRouterVersion;
const expectedOpenCodeRouterVersion = normalizedOpenCodeRouterVersion || opencodeRouterPkgVersion;

if (!expectedOpenCodeRouterVersion) {
  console.error("OpenCodeRouter version missing. Set opencodeRouterVersion or ensure package.json has version.");
  process.exit(1);
}

if (normalizedOpenCodeRouterVersion && opencodeRouterPkgVersion && normalizedOpenCodeRouterVersion !== opencodeRouterPkgVersion) {
  console.error(`OpenCodeRouter version mismatch: desktop=${normalizedOpenCodeRouterVersion}, package=${opencodeRouterPkgVersion}`);
  process.exit(1);
}

let didBuildOpenCodeRouter = false;
const shouldBuildOpenCodeRouter = forceBuild || !existsSync(opencodeRouterBuildPath) || isStubBinary(opencodeRouterBuildPath);
if (shouldBuildOpenCodeRouter) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(opencodeRouterBuildPath)) {
    try {
      unlinkSync(opencodeRouterBuildPath);
    } catch {
      // ignore
    }
  }
  const opencodeRouterScript = resolveBuildScript(opencodeRouterDir);
  if (!existsSync(opencodeRouterScript)) {
    console.error(`OpenCodeRouter build script not found at ${opencodeRouterScript}`);
    process.exit(1);
  }
  const opencodeRouterArgs = [opencodeRouterScript, "--outdir", sidecarDir, "--filename", "opencode-router"];
  if (bunTarget) {
    opencodeRouterArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", opencodeRouterArgs, { cwd: opencodeRouterDir, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOpenCodeRouter = true;
}

if (existsSync(opencodeRouterBuildPath)) {
  const shouldCopyCanonical = didBuildOpenCodeRouter || !existsSync(opencodeRouterPath) || isStubBinary(opencodeRouterPath);
  if (shouldCopyCanonical && opencodeRouterBuildPath !== opencodeRouterPath) {
    try {
      if (existsSync(opencodeRouterPath)) unlinkSync(opencodeRouterPath);
    } catch {
      // ignore
    }
    copyFileSync(opencodeRouterBuildPath, opencodeRouterPath);
  }

  if (opencodeRouterTargetPath) {
    const shouldCopyTarget = didBuildOpenCodeRouter || !existsSync(opencodeRouterTargetPath) || isStubBinary(opencodeRouterTargetPath);
    if (shouldCopyTarget && opencodeRouterBuildPath !== opencodeRouterTargetPath) {
      try {
        if (existsSync(opencodeRouterTargetPath)) unlinkSync(opencodeRouterTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(opencodeRouterBuildPath, opencodeRouterTargetPath);
    }
  }
}

// Build orchestrator sidecar
let didBuildOrchestrator = false;
const shouldBuildOrchestrator =
  forceBuild || !existsSync(orchestratorBuildPath) || isStubBinary(orchestratorBuildPath);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  const orchestratorArgs = [
    orchestratorBuildScript,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical =
    didBuildOrchestrator || !existsSync(orchestratorPath) || isStubBinary(orchestratorPath);
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    try {
      if (existsSync(orchestratorPath)) unlinkSync(orchestratorPath);
    } catch {
      // ignore
    }
    copyFileSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget =
      didBuildOrchestrator ||
      !existsSync(orchestratorTargetPath) ||
      isStubBinary(orchestratorTargetPath);
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      try {
        if (existsSync(orchestratorTargetPath)) unlinkSync(orchestratorTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

// Build chrome-devtools-mcp shim sidecar
let didBuildChromeDevtools = false;
const shouldBuildChromeDevtools =
  forceBuild || !existsSync(chromeDevtoolsBuildPath) || isStubBinary(chromeDevtoolsBuildPath);
if (shouldBuildChromeDevtools) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(chromeDevtoolsBuildPath)) {
    try {
      unlinkSync(chromeDevtoolsBuildPath);
    } catch {
      // ignore
    }
  }

  if (!existsSync(chromeDevtoolsShimPath)) {
    console.error(`Chrome DevTools MCP shim source not found at ${chromeDevtoolsShimPath}`);
    process.exit(1);
  }

  const chromeDevtoolsArgs = [
    "build",
    "--compile",
    chromeDevtoolsShimPath,
    "--outfile",
    chromeDevtoolsBuildPath,
  ];
  if (bunTarget) {
    chromeDevtoolsArgs.push("--target", bunTarget);
  }

  const result = spawnSync("bun", chromeDevtoolsArgs, {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildChromeDevtools = true;
}

if (existsSync(chromeDevtoolsBuildPath)) {
  const shouldCopyCanonical =
    didBuildChromeDevtools || !existsSync(chromeDevtoolsPath) || isStubBinary(chromeDevtoolsPath);
  if (shouldCopyCanonical && chromeDevtoolsBuildPath !== chromeDevtoolsPath) {
    try {
      if (existsSync(chromeDevtoolsPath)) unlinkSync(chromeDevtoolsPath);
    } catch {
      // ignore
    }
    copyFileSync(chromeDevtoolsBuildPath, chromeDevtoolsPath);
  }

  if (chromeDevtoolsTargetPath) {
    const shouldCopyTarget =
      didBuildChromeDevtools ||
      !existsSync(chromeDevtoolsTargetPath) ||
      isStubBinary(chromeDevtoolsTargetPath);
    if (shouldCopyTarget && chromeDevtoolsBuildPath !== chromeDevtoolsTargetPath) {
      try {
        if (existsSync(chromeDevtoolsTargetPath)) unlinkSync(chromeDevtoolsTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(chromeDevtoolsBuildPath, chromeDevtoolsTargetPath);
    }
  }
}

adHocSignDarwinSidecars([
  openworkServerBuildPath,
  openworkServerPath,
  openworkServerTargetPath,
  opencodeRouterBuildPath,
  opencodeRouterPath,
  opencodeRouterTargetPath,
  orchestratorBuildPath,
  orchestratorPath,
  orchestratorTargetPath,
  chromeDevtoolsBuildPath,
  chromeDevtoolsPath,
  chromeDevtoolsTargetPath,
]);

const openworkServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(openworkServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  "openwork-server": {
    version: openworkServerVersion,
    sha256: existsSync(openworkServerPath) ? sha256File(openworkServerPath) : null,
  },
  opencodeRouter: {
    version: expectedOpenCodeRouterVersion,
    sha256: existsSync(opencodeRouterPath) ? sha256File(opencodeRouterPath) : null,
  },
  "openwork-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath) ? sha256File(orchestratorPath) : null,
  },
  "chrome-devtools-mcp": {
    version: chromeDevtoolsMcpVersion,
    sha256: existsSync(chromeDevtoolsPath) ? sha256File(chromeDevtoolsPath) : null,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = isWindowsTarget ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
