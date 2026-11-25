// Playground for the core: a page of cards, links and a dense toolbar using each part of the API, plus a per-frame
// timing readout for the benchmark. Run with `npm run playground`.

import { createBeeline } from "beeline";
import weights from "beeline/default-weights.json";
import { predictTargetProbabilities } from "../src/model.ts";

const beeline = createBeeline();

// Page ----------

const cards = document.querySelector("#cards")!;
for (let index = 1; index <= 8; index++) {
  cards.insertAdjacentHTML("beforeend", `<a class="card" href="#card-${index}">Card ${index}</a>`);
}
const links = document.querySelector("#links")!;
for (let index = 1; index <= 24; index++) {
  links.insertAdjacentHTML("beforeend", `<li><a href="#link-${index}">Link number ${index}</a><output></output></li>`);
}
const toolbar = document.querySelector("#toolbar")!;
for (let index = 1; index <= 24; index++) toolbar.insertAdjacentHTML("beforeend", `<button>${index}</button>`);

// Links are only for show.
document.addEventListener("click", (event) => {
  if ((event.target as Element).closest("a")) event.preventDefault();
});

// API ----------

for (const card of document.querySelectorAll(".card")) beeline.watch(card);

for (const link of document.querySelectorAll(".links a")) {
  const output = link.nextElementSibling!;
  beeline.watch(link, (probability) => (output.textContent = probability >= 0.01 ? `${Math.round(probability * 100)}%` : ""));
}

for (const button of document.querySelectorAll(".toolbar button")) {
  beeline.when(button, { above: 0.5, below: 0.3 }, { enter: () => button.classList.add("hot"), leave: () => button.classList.remove("hot") });
}

const onceButton = document.querySelector("#once")!;
beeline.when(onceButton, { above: 0.5 }, { enter: () => onceButton.classList.add("fired"), once: true });

document.querySelector("#add-targets")!.addEventListener("click", () => {
  const many = document.querySelector("#many")!;
  for (let index = 0; index < 200; index++) many.insertAdjacentHTML("beforeend", `<button>${many.children.length + 1}</button>`);
});

// Benchmark ----------

// The model's time per frame, timed by running it again on the same frame.
const frameTimesMs: number[] = [];
const stats = document.querySelector("#stats")!;
beeline.onFrame(({ targetRects, history }) => {
  const start = performance.now();
  predictTargetProbabilities(weights, history, targetRects);
  frameTimesMs.push(performance.now() - start);
  if (frameTimesMs.length > 120) frameTimesMs.shift();
  const sorted = [...frameTimesMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  stats.textContent = `${targetRects.length} visible targets · model ${median.toFixed(2)} ms median, ${p95.toFixed(2)} ms p95 per frame (budget 1 ms at 200 targets)`;
});
