import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("setup restricts an existing config before saving and does not print credentials", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-permissions-"));
  const config = join(directory, ".env");
  const fixture = "synthetic-test-credential";
  try {
    writeFileSync(config, `PI_TELEGRAM_BOT_TOKEN=${fixture}\n`);
    chmodSync(config, 0o644);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/pi-telegram.mjs", import.meta.url)), "setup", "--chat-id", "123"], {
      cwd: directory,
      env: { ...process.env, PI_TELEGRAM_CONFIG_DIR: directory },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.ok(readFileSync(config, "utf8").includes(fixture));
    assert.ok(!(result.stdout + result.stderr).includes(fixture));
  } finally {
    rmSync(directory, { recursive: true });
  }
});
