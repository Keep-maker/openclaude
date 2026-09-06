import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

for (const host of [undefined, "0.0.0.0"]) {
  test(`foreground router: ${host ?? "loopback default"}, HTTP and SIGTERM`, { timeout: 15000 }, async (t) => {
    // 同时验证配置目录包含空格的情况。
    const home = await mkdtemp(join(tmpdir(), "oc deployment "));
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, "config.json"), JSON.stringify({ port: 0 }));
    const env = { ...process.env, OPENCLAUDE_HOME: home, OPENCLAUDE_PORT: "0" };
    delete env.OPENCLAUDE_QUIET;
    delete env.OPENCLAUDE_HOST;
    if (host) env.OPENCLAUDE_HOST = host;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/router/index.js", import.meta.url))], {
      env, stdio: ["ignore", "ignore", "pipe"],
    });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let output = "";
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 5000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${output}`)); });
      child.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/listening on http:\/\/([^:]+):(\d+)/);
        if (match) { clearTimeout(timer); resolve({ host: match[1], port: match[2] }); }
      });
    });
    assert.equal(address.host, host ?? "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/openclaude/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    if (process.platform !== "win32") {
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.match(output, /shutting down/);
    }
  });
}
