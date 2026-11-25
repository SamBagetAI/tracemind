#!/usr/bin/env node
/**
 * Re-records the README's pictures from made-up data, never your own sessions:
 *
 *   pnpm record
 *
 * - docs/tour.gif: the Diary, a session with its failed calls, back, then the fixes to review.
 * - docs/social-preview.png: the 1280×640 card for GitHub (Settings → General → Social preview),
 *   checked to sit inside GitHub's 80px border.
 *
 * It fills a throwaway Tracemind home with scripts/demo.mjs, runs the built UI on a spare port and
 * drives your installed Google Chrome with playwright-core. Run `pnpm build` first (`pnpm record` does).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4561;
const W = 960;
const H = 540;
const FPS = 10;

/** A Tracemind home with the demo sessions, and the UI running on it. */
async function startDemo() {
  const home = mkdtempSync(join(tmpdir(), "tm-record-"));
  const env = { ...process.env, TRACEMIND_HOME: home };
  const fill = spawnSync(process.execPath, [join(repo, "scripts/demo.mjs")], { env, stdio: ["ignore", "ignore", "inherit"] });
  if (fill.status !== 0) throw new Error("scripts/demo.mjs failed; run pnpm build first");
  const ui = spawn(process.execPath, [join(repo, "dist/src/cli/index.js"), "ui", "--port", String(PORT), "--no-open"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ready, fail) => {
    ui.stdout.on("data", (b) => b.toString().includes("running at") && ready());
    ui.on("exit", (code) => fail(new Error(`tracemind ui exited (${code})`)));
  });
  return { stop: () => (ui.kill(), rmSync(home, { recursive: true, force: true })) };
}

/** A 2× screenshot as W×H RGBA, each pixel the average of four: sharper text than a 1× capture. */
function halve(png) {
  const src = PNG.sync.read(png);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 4; c++) {
        const at = (yy, xx) => src.data[((y * 2 + yy) * src.width + x * 2 + xx) * 4 + c];
        out[(y * W + x) * 4 + c] = (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1)) >> 2;
      }
    }
  }
  return out;
}

async function recordTour(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const frames = [];
  const hold = async (seconds) => {
    for (let i = 0; i < seconds * FPS; i++) {
      const t = Date.now();
      frames.push(await page.screenshot());
      const left = 1000 / FPS - (Date.now() - t);
      if (left > 0) await page.waitForTimeout(left);
    }
  };
  const open = async (target) => {
    await target.hover();
    await hold(0.5);
    await target.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(150);
  };

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await hold(2.5);
  await open(page.getByText("Upgrade the navigation library").first());
  await hold(2.5);
  await page.mouse.wheel(0, 300);
  await hold(1.5);
  await page.goBack({ waitUntil: "networkidle" });
  await hold(0.8);
  await open(page.getByText(/fixes to review/).first());
  await hold(3);
  await page.close();

  // One palette for every frame, taken from the start, middle and end, so colors don't flicker.
  const pixels = frames.map(halve);
  const sample = new Uint8Array(W * H * 4 * 3);
  [0, pixels.length >> 1, pixels.length - 1].forEach((k, i) => sample.set(pixels[k], i * W * H * 4));
  const palette = quantize(sample, 127);
  // A frame keeps only the pixels that changed; the rest are see-through and show the frame
  // before, which is most of the page and keeps the file small.
  const CLEAR = palette.length;
  palette.push([255, 0, 255]);
  const gif = GIFEncoder();
  let previous = null;
  for (const p of pixels) {
    const index = applyPalette(p, palette.slice(0, CLEAR));
    const frame = previous ? index.map((v, i) => (v === previous[i] ? CLEAR : v)) : index;
    // dispose 1 keeps the frame before under this one; the palette is written once, with the first.
    gif.writeFrame(frame, W, H, { palette: previous ? null : palette, delay: 1000 / FPS, transparent: !!previous, transparentIndex: CLEAR, dispose: 1 });
    previous = index;
  }
  gif.finish();
  writeFileSync(join(repo, "docs/tour.gif"), gif.bytes());
  return frames.length;
}

async function renderCard(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await page.goto(pathToFileURL(join(repo, "scripts/social.html")).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll(".safe *")]
      .map((e) => [e.className || e.tagName, e.getBoundingClientRect()])
      .filter(([, r]) => r.left < 80 || r.top < 80 || r.right > 1200 || r.bottom > 560)
      .map(([name]) => name),
  );
  if (outside.length) throw new Error(`the social card crosses GitHub's 80px border: ${outside.join(", ")}`);
  await page.screenshot({ path: join(repo, "docs/social-preview.png") });
  await page.close();
}

const demo = await startDemo();
const browser = await chromium.launch({ channel: "chrome" }).catch((e) => {
  demo.stop();
  throw new Error(`could not start Google Chrome (playwright-core uses the installed one): ${e.message}`);
});
try {
  const n = await recordTour(browser);
  await renderCard(browser);
  console.log(`docs/tour.gif (${n} frames) and docs/social-preview.png written`);
} finally {
  await browser.close();
  demo.stop();
}
