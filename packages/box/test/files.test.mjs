import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpError, readPlacedFile, sendRawFile } from "../server.mjs";

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gond-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rawServer(t, home) {
  const account = { home, logins: [path.join(home, ".claude")], browser: path.join(home, ".config/gond-browser"), browsers: path.join(home, ".config/gond-browser-bots"), skills: path.join(home, ".skills") };
  const server = createServer((request, response) => {
    try {
      sendRawFile(response, account, new URL(request.url, "http://box").searchParams.get("path"));
    } catch (error) {
      response.writeHead(error instanceof HttpError ? error.status : 500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (relative) => fetch(`http://127.0.0.1:${server.address().port}/?path=${encodeURIComponent(relative)}`);
}

test("a shared file streams whole, with its length, from the descriptor that was checked", async (t) => {
  const home = tempDir(t, "home");
  const bytes = randomBytes(3 * 1024 * 1024 + 17);
  fs.writeFileSync(path.join(home, "report.bin"), bytes);
  fs.writeFileSync(path.join(home, "empty.txt"), "");
  const get = await rawServer(t, home);

  const answer = await get("report.bin");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-type"), "application/octet-stream");
  assert.equal(answer.headers.get("content-length"), String(bytes.length));
  assert.ok(Buffer.from(await answer.arrayBuffer()).equals(bytes));

  const empty = await get("empty.txt");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("content-length"), "0");
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
});

test("a shared file through a link out of the home, a sign-in or a folder is refused before anything is sent", async (t) => {
  const home = tempDir(t, "home");
  const outside = tempDir(t, "outside");
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(home, "link.txt"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "credentials.json"), "{}");
  fs.mkdirSync(path.join(home, "folder"));
  const get = await rawServer(t, home);

  for (const [relative, status] of [["link.txt", 400], [".claude/credentials.json", 400], ["folder", 400], ["missing.txt", 404]]) {
    const answer = await get(relative);
    assert.equal(answer.status, status, relative);
    const body = await answer.json();
    assert.equal(typeof body.error, "string");
    assert.doesNotMatch(JSON.stringify(body), /not yours/);
  }
});

test("a file left in a screen's folder is read only when it's a plain file in a folder that hasn't moved", (t) => {
  const run = tempDir(t, "run");
  const outside = tempDir(t, "outside");
  fs.writeFileSync(path.join(run, "shot.png"), "picture");
  fs.writeFileSync(path.join(outside, "secret"), "not yours");
  fs.symlinkSync(path.join(outside, "secret"), path.join(run, "planted.png"));
  execFileSync("mkfifo", [path.join(run, "pipe.png")]);
  fs.symlinkSync(run, path.join(outside, "moved"));

  assert.deepEqual(readPlacedFile(run, "shot.png"), { misplaced: false, data: Buffer.from("picture") });
  assert.deepEqual(readPlacedFile(run, "planted.png"), { misplaced: false, data: null });
  assert.deepEqual(readPlacedFile(run, "pipe.png"), { misplaced: false, data: null });
  assert.deepEqual(readPlacedFile(run, "missing.png"), { misplaced: false, data: null });
  assert.deepEqual(readPlacedFile(run, "shot.png", 3), { misplaced: false, data: null });
  assert.deepEqual(readPlacedFile(path.join(outside, "moved"), "shot.png"), { misplaced: true, data: null });
});
