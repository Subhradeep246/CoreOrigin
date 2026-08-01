import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Next.js server did not become ready on port ${port}`);
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const port = 19_000 + Math.floor(Math.random() * 1000);
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });

  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  try {
    await waitForServer(port);
    await run(port);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

test("server-renders complete Voia experience", async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(html, /<title>Find the right care, in your voice \| Voia<\/title>/i);
    assert.match(
      html,
      /<meta property="og:image" content="https?:\/\/(?:localhost(?::\d+)?|coinorigin\.app)\/og\.png"/i,
    );
    assert.match(html, /Care starts with/);
    assert.match(html, /being heard/);
    assert.match(html, /Request appointment/);
    assert.match(html, /Protected preview/);
    assert.match(html, /Screening is currently off/);
    assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  });
});

test("renders semantic page landmarks", async () => {
  await withServer(async (port) => {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<main>/i);
    assert.match(html, /<header class="site-header">/i);
    assert.match(html, /<nav aria-label="Main navigation">/i);
    assert.match(html, /<h1>/i);
    assert.match(html, /<footer>/i);
  });
});
