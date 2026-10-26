// Real-Chromium runs of the challenges a bot meets on an order page. Five it finishes
// itself — press-and-hold, matching one icon, picking every picture with a train,
// clicking icons in order, and a plain "not a robot" box — and one it does not guess
// at: a slider is handed to the person, who takes the mouse and completes it. Each run
// records a video and a solved-state picture under test/artifacts/captcha.
//
// The model's part (looking at a screenshot and choosing what to click) is played by
// the DOM here, so what is under test is the part that used to fail: the hands.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { CHROME_ARGS, createBrowser } from "../browser-host.mjs";
import { parseSteps } from "../computer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "challenges.html");
const artifacts = path.join(here, "artifacts", "captcha");
const VIEWPORT = { width: 1280, height: 800 };
const steps = (list) => parseSteps(list, "browser", VIEWPORT);

function chromePath() {
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  const found = [];
  try {
    for (const entry of fsSync.readdirSync(cache).filter((name) => name.startsWith("chromium-"))) {
      for (const relative of ["chrome-linux64/chrome", "chrome-linux/chrome"]) found.push(path.join(cache, entry, relative));
    }
  } catch {
    /* no cache */
  }
  let bundled = null;
  try {
    bundled = chromium.executablePath();
  } catch {
    /* no bundled browser */
  }
  return [process.env.CHROME_BIN, bundled, ...found].filter((candidate) => candidate && fsSync.existsSync(candidate))[0] ?? null;
}

// Playwright's video recorder needs the ffmpeg build of the matching version; without it the
// challenge runs could still be checked but there would be nothing to watch, so this file skips.
function ffmpegInstalled() {
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    return fsSync.readdirSync(cache).filter((name) => name.startsWith("ffmpeg-")).some((name) => fsSync.existsSync(path.join(cache, name, "ffmpeg-linux")));
  } catch {
    return false;
  }
}

const executablePath = chromePath();
const skip = executablePath ? (ffmpegInstalled() ? false : "Playwright's ffmpeg isn't installed, so there is no video to make") : "Chromium isn't installed for playwright-core";

async function serveFixture() {
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/challenges.html")) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = await fs.readFile(fixture);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const center = (page, selector) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }, selector);

const centers = (page, selector) =>
  page.evaluate((selector) =>
    [...document.querySelectorAll(selector)].map((element) => {
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    }), selector);

async function recordChallenge(base, name, drive, kind = name) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `gond-${name}-profile-`));
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), `gond-${name}-video-`));
  await fs.mkdir(artifacts, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
    ignoreDefaultArgs: ["--enable-automation"],
    args: [...CHROME_ARGS, "--no-sandbox"],
  });
  const browser = createBrowser({ launch: async () => context });
  const page = context.pages()[0] ?? (await context.newPage());
  const video = page.video();
  let videoPath = null;
  try {
    const opened = await browser.run(steps([{ type: "navigate", url: `${base}/challenges.html?c=${kind}` }]), { view: "both" });
    assert.equal(opened.error, null, `opening ${kind}`);
    assert.equal(opened.url, `${base}/challenges.html?c=${kind}`);
    await drive({ browser, page, run: (list, options) => browser.run(steps(list), { view: "image", ...options }) });
    await page.waitForFunction(() => document.body.dataset.solved === "true", null, { timeout: 10_000 });
    // A beat on the finished state, so the video ends on the green "Verified" line.
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    return { page, browser, video };
  } finally {
    await browser.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    videoPath = await video?.path().catch(() => null);
    if (videoPath) await fs.copyFile(videoPath, path.join(artifacts, `${name}.webm`)).catch(() => undefined);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("press and hold passes", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "hold", async ({ page, run }) => {
      const button = await center(page, "#holdButton");
      assert.ok(button, "the hold button is on the page");
      await run([{ type: "hold", x: button.x, y: button.y, ms: 2400 }]);
    });
  } finally {
    server.close();
  }
});

test("match one icon passes", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "match", async ({ page, browser, run }) => {
      const target = await page.evaluate(() => document.body.dataset.targetIcon);
      // The model can ask for just the picture grid when the icons are small on a full screenshot.
      const zoomed = await browser.run(steps([{ type: "screenshot" }]), { view: "image", zoom: { x: 320, y: 120, width: 440, height: 330 } });
      assert.deepEqual(zoomed.zoom, { x: 320, y: 120, width: 440, height: 330 });
      assert.equal(zoomed.width, 440);
      assert.equal(zoomed.height, 330);
      const tile = await page.evaluate((target) => {
        const element = document.querySelector(`.tile[data-icon="${target}"]`);
        const box = element.getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      }, target);
      await run([{ type: "click", x: tile.x, y: tile.y }]);
      const verify = await center(page, ".btn");
      await run([{ type: "click", x: verify.x, y: verify.y }]);
    });
  } finally {
    server.close();
  }
});

test("select every train passes", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "trains", async ({ page, run }) => {
      const trains = await page.evaluate(() =>
        [...document.querySelectorAll(".tile[data-icon='train']")].map((element) => {
          const box = element.getBoundingClientRect();
          return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
        }));
      assert.ok(trains.length >= 3, "the grid has trains");
      await run([{ type: "click", points: trains, delay: 90 }]);
      const verify = await center(page, ".btn");
      await run([{ type: "click", x: verify.x, y: verify.y }]);
    });
  } finally {
    server.close();
  }
});

test("click the icons in order passes", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "order", async ({ page, run }) => {
      const order = await page.evaluate(() => document.body.dataset.order.split(","));
      const points = await page.evaluate((order) =>
        order.map((name) => {
          const element = document.querySelector(`.tile[data-icon="${name}"]`);
          const box = element.getBoundingClientRect();
          return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
        }), order);
      await run([{ type: "click", points, delay: 130 }]);
    });
  } finally {
    server.close();
  }
});

test("a slider the bot won't guess at is handed to the person, who completes it", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "handoff", async ({ page }) => {
      // The bot stops instead of guessing, and the person takes the mouse: this is the hand-off path.
      await page.evaluate(() => {
        const banner = document.createElement("div");
        banner.id = "handoffBanner";
        banner.innerHTML = '<strong style="font-size:17px">Take Control</strong><span style="display:block;margin-top:2px;font-weight:500;opacity:.85">It needs you — it couldn\'t finish this one itself.</span>';
        Object.assign(banner.style, {
          position: "fixed",
          left: "50%",
          top: "24px",
          transform: "translateX(-50%)",
          zIndex: 10000,
          maxWidth: "720px",
          padding: "14px 20px",
          borderRadius: "12px",
          background: "#17202e",
          color: "#fff",
          font: "600 15px ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 14px 40px rgba(23,32,46,.28)",
          textAlign: "center",
        });
        document.body.append(banner);
      });
      await page.waitForTimeout(700);
      const handle = await center(page, ".sliderHandle");
      const gap = await page.evaluate(() => {
        const box = document.querySelector(".sliderGap").getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      });
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.waitForTimeout(120);
      for (let step = 1; step <= 18; step++) {
        const t = step / 18;
        await page.mouse.move(handle.x + (gap.x - handle.x) * t, handle.y + (gap.y - handle.y) * t);
        await page.waitForTimeout(28);
      }
      await page.mouse.up();
    }, "slider");
  } finally {
    server.close();
  }
});

test("a plain not-a-robot box passes", { skip }, async () => {
  const { server, base } = await serveFixture();
  try {
    await recordChallenge(base, "checkbox", async ({ page, run }) => {
      const box = await center(page, "#robotCheck");
      await run([{ type: "click", x: box.x, y: box.y }]);
      await page.waitForTimeout(1400);
    });
  } finally {
    server.close();
  }
});

test("the recorded runs left a video and a solved picture for each challenge", { skip }, async () => {
  const names = ["hold", "match", "trains", "order", "checkbox", "handoff"];
  for (const name of names) {
    const video = await fs.stat(path.join(artifacts, `${name}.webm`)).catch(() => null);
    const picture = await fs.stat(path.join(artifacts, `${name}.png`)).catch(() => null);
    assert.ok(video && video.size > 1_000, `${name}.webm exists and has frames`);
    assert.ok(picture && picture.size > 1_000, `${name}.png exists`);
  }
});
