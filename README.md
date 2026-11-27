<p align="center"><img src="packages/extension/static/icons/icon-128.png" width="96" alt="" /></p>
<h1 align="center">beeline</h1>

beeline is a Chrome extension that prefetches the link your cursor is heading for, so the next page opens sooner. It
works on any site from install, with default weights trained on other people's cursor movement. Then it learns how you
move, on your own device.

beeline is a proof of concept. It is not on the Chrome Web Store.

## Install

1. Install the packages: `npm install`.
2. Build the extension: `npm run build`.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select `packages/extension/dist/`.

## Use

beeline prefetches a link when the model expects a click on it, when the cursor rests on it for 100 ms, when it gets
keyboard focus, or when a touch starts on it. It only prefetches:

- links on the same origin as the page,
- that don't look like an action (logout, delete, cart, unsubscribe and similar),
- that aren't downloads or the current page,
- on pages without their own speculation rules.

It never prerenders. To turn prefetching off for a site, open the popup on that site and turn off **Prefetch on**.

The popup also shows which weights are running. The extension runs the default weights until it has 100 of your
usable clicks. Then it updates all 32 hidden units and the output layer in the background every 100 new usable clicks.
The extension prefetches at a predicted click probability of 0.22.

To compare the model with [Foresight](https://foresightjs.com), turn on **Show predictions** in the popup.

## Results

After the first 100 usable clicks, Beeline anticipated **94 of 117** same-origin navigations on 126 later pages from one trackpad user. It left **51%** as many prefetches unused as Foresight.

| Policy | Estimated wait saved per navigation | Unused prefetches (% of Foresight) |
|---|---:|---:|
| Hover | 176 ms | 123 (18%) |
| Beeline + hover | 276 ms | 357 (51%) |
| Foresight + hover | 290 ms | 701 (100%) |

Run `npm run eval -- data/<export>.jsonl` to score all three policies. The table above uses `data/traces-2026-11-24.jsonl`. By default, the benchmark fine-tunes the bundled weights on the first 100 usable clicks. It scores later v2 click windows after the 80% split of clicks where the cursor moved onto a target, excluding pages used for fine-tuning. To compare an already-fitted candidate on the same windows, pass its weights JSON as the second argument. Train the candidate only on data outside those test pages.

Choose the model that saves the most wait while leaving at most 70% as many prefetches unused as Foresight. Each same-origin navigation gets up to 400 ms credit for prefetch lead time, with zero for a miss. Each destination counts once per page. An unused prefetch has no matching later navigation in the recorded windows.

On the test MacBook, scoring 200 targets took about **0.14 ms per frame** in Node. The first whole-model update took **7.1–7.2 seconds** in a Chromium worker.

## What it stores

Everything stays in `chrome.storage.local` in your browser. Nothing is sent anywhere.

- `trace:` and `outcome:` records: one per click. You can export them as JSONL under **Advanced**.
- `training:` records: clicks from versions before 0.1.0 made while recording was off, kept for fine-tuning only. They are never exported.
- `personalModel`: your fine-tuned weights.
- `timeSaved`: the time prefetching saved. For each prefetched page you open, that's how long its prefetch took to its
  first response byte, minus what the page still waited after the click, totalled and kept for the last 10 pages. The background times prefetches through
  `webRequest`, holding them in memory only.
- Settings, and the sites with prefetching off.

**Reset beeline**, under **Advanced** in the popup, deletes every click record, your fine-tuned weights and the time saved, so the default weights run again.

Traces are geometry only: cursor positions and target rectangles. They contain no URLs, page text or element contents.
See [PRIVACY.md](PRIVACY.md).

## Development

- `packages/extension/`: the extension.
- `packages/beeline/`: the model, target tracking and prefetching, which the extension imports.
- `eval/`: replays exported traces through the model and the baselines.
- `train/`: trains the model (Python, needs [uv](https://docs.astral.sh/uv/)).

`npm run watch` rebuilds on each change.

Checks:

```
npm run typecheck
npm run build
npm test
```

`npm run eval -- data/<export>.jsonl` runs the benchmark. `npm run train -- data/adserp-traces.jsonl`
retrains the default weights. See [AGENTS.md](AGENTS.md) for training and data details.

The Foresight baseline is ported from Foresight.js 4.3.0 (MIT). The default weights are trained on the AdSERP dataset
(Zenodo 15236546, CC BY 4.0).
