// Converts the AdSERP dataset (Zenodo 15236546, CC BY 4.0: 47 people, a mouse, Google result pages) to beeline traces.
// Each trial's HTML snapshot is rendered offline at its window size and scrolled to where the page was at the click, and
// every on-screen target is measured as the extension would. Network requests are all blocked.
// Usage: npm run convert-adserp -- <dir with mouse-movement-data/, trial-metadata/ and serps/ unzipped> <out.jsonl>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { TARGET_SELECTOR } from "../src/targets.ts";
import type { Trace } from "./replay.ts";

// The extension keeps about this much cursor history before a click.
const HISTORY_MS = 1000;

const [adserpDir, outPath] = process.argv.slice(2);
const browser = await chromium.launch();
const traces: Trace[] = [];
const skipCounts: Record<string, number> = {};
let page: Page | undefined;
let pageWindow = "";

for (const file of readdirSync(`${adserpDir}/mouse-movement-data`).filter((name) => name.endsWith(".csv"))) {
  const trialId = file.replace(".csv", "");
  const window = readFileSync(`${adserpDir}/trial-metadata/${trialId}.xml`, "utf8").match(/<window>(\d+)x(\d+)/)!;
  const rows = readFileSync(`${adserpDir}/mouse-movement-data/${file}`, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [t, x, y, event, ...xpath] = line.split(",");
      return { t: Number(t), x: Number(x), y: Number(y), event, xpath: xpath.join(",") };
    });
  // The first mousedown is the click; `click` itself lands about a second later, after the study's dialog.
  const down = rows.find(({ event }) => event === "mousedown");
  if (!down) {
    skipCounts["no mousedown"] = (skipCounts["no mousedown"] ?? 0) + 1;
    continue;
  }
  // Scroll rows hold the page's scroll offset in `y`; mouse rows are in page coordinates.
  const lastScroll = rows.findLast(({ event, t }) => event === "scroll" && t <= down.t);
  const scrollY = lastScroll?.y ?? 0;
  const moves = rows.filter(({ event, t }) => event === "mousemove" && t > (lastScroll?.t ?? -Infinity) && t >= down.t - HISTORY_MS && t < down.t);
  // At ~60 Hz every sample is about one animation frame.
  const samples: Trace["samples"] = [...moves, down].map(({ t, x, y }) => [t - down.t, x, Math.round((y - scrollY) * 10) / 10, x, Math.round((y - scrollY) * 10) / 10, 1]);

  if (window[0] !== pageWindow) {
    await page?.context().close();
    page = await (await browser.newContext({ viewport: { width: Number(window[1]), height: Number(window[2]) } })).newPage();
    await page.route("**/*", (route) => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
    pageWindow = window[0];
  }
  await page!.goto(`file://${adserpDir}/serps/${trialId}.html`, { waitUntil: "load" });
  const measured = await page!.evaluate(
    ({ down, scrollY, TARGET_SELECTOR }) => {
      scrollTo(0, scrollY);
      const clickedElement = document.evaluate(down.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
      if (!clickedElement) return "xpath not found";
      // The re-render must match what the person saw: the click lands inside the element it was recorded on.
      const clickedRect = clickedElement.getBoundingClientRect();
      const clickY = down.y - scrollY;
      if (down.x < clickedRect.left - 2 || down.x > clickedRect.right + 2 || clickY < clickedRect.top - 2 || clickY > clickedRect.bottom + 2) return "click outside element";
      const targetElements: Element[] = [];
      const targets: [number, number, number, number][] = [];
      for (const element of document.querySelectorAll(TARGET_SELECTOR)) {
        const rect = element.getBoundingClientRect();
        if (rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && rect.width > 0 && rect.height > 0) {
          targetElements.push(element);
          targets.push([rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10) as [number, number, number, number]);
        }
      }
      return {
        viewport: [innerWidth, innerHeight] as [number, number],
        targets,
        clicked: targetElements.indexOf(clickedElement.closest(TARGET_SELECTOR)!),
        pointerCursor: getComputedStyle(clickedElement).cursor === "pointer",
      };
    },
    { down, scrollY, TARGET_SELECTOR },
  );
  if (typeof measured === "string") {
    skipCounts[measured] = (skipCounts[measured] ?? 0) + 1;
    continue;
  }
  traces.push({ id: `adserp-${trialId}`, person: `adserp-${trialId.split("-")[0]}`, time: down.t, device: "mouse", samples, ...measured });
}

await browser.close();
writeFileSync(outPath, traces.map((trace) => JSON.stringify(trace)).join("\n") + "\n");
console.log(`Wrote ${traces.length} traces. Skipped:`, skipCounts);
