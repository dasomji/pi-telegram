#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_NAME = "pi-telegram";
const PACKAGE_MARKER = "@wienerberliner/pi-telegram";

function log(message) {
  console.log(`[pi-telegram] ${message}`);
}

function warn(message) {
  console.warn(`[pi-telegram] ${message}`);
}

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function targetBinDir() {
  const home = homedir();
  if (!home || home === "/") return undefined;
  return join(home, ".local", "bin");
}

function isPiTelegramLinkTarget(target) {
  return target.includes(`/node_modules/${PACKAGE_MARKER}/`) || target.includes(`\\node_modules\\${PACKAGE_MARKER.replace("/", "\\\\")}\\`);
}

function linkCli() {
  if (process.platform === "win32") {
    warn("Skipping PATH shim on Windows. Use npm's generated .cmd shim or call the CLI with node.");
    return;
  }

  const binDir = targetBinDir();
  if (!binDir) {
    warn("Could not determine a home directory; skipping ~/.local/bin CLI shim.");
    return;
  }

  const source = join(packageRoot(), "bin", "pi-telegram.mjs");
  const destination = join(binDir, CLI_NAME);
  mkdirSync(binDir, { recursive: true });

  if (existsSync(destination)) {
    const stats = lstatSync(destination);
    if (!stats.isSymbolicLink()) {
      warn(`Not overwriting existing non-symlink at ${destination}. CLI is still available at ${source}.`);
      return;
    }

    const currentTarget = readlinkSync(destination);
    let resolvedTarget = currentTarget;
    try {
      resolvedTarget = realpathSync(destination);
    } catch {
      // Broken symlink: only replace it if the literal target is clearly from this package.
    }

    if (currentTarget === source || resolvedTarget === source) {
      log(`CLI already linked at ${destination}.`);
      return;
    }

    if (!isPiTelegramLinkTarget(currentTarget) && !isPiTelegramLinkTarget(resolvedTarget)) {
      warn(`Not overwriting existing symlink at ${destination} -> ${currentTarget}. CLI is still available at ${source}.`);
      return;
    }

    unlinkSync(destination);
  }

  symlinkSync(source, destination);
  log(`Linked CLI: ${destination} -> ${source}`);
}

try {
  linkCli();
} catch (error) {
  warn(`Could not create CLI shim: ${error instanceof Error ? error.message : String(error)}`);
}
