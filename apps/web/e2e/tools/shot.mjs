// Usage: node e2e/shot.mjs <path> <out.png> [light|dark] [width] [height] [fullPage]
import { chromium } from "@playwright/test";

const [path = "/", out = "/tmp/shot.png", theme = "light", w = "1440", h = "1000", full = "1"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, colorScheme: theme });
await page.addInitScript((t) => {
  try { localStorage.setItem("lab-theme", t); } catch {}
}, theme);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`http://localhost:3100${path}`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: out, fullPage: full === "1" });
console.log("title:", await page.title(), "| console errors:", errors.length ? errors.join(" || ") : "none");
await browser.close();
