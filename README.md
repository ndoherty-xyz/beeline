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
clicks. Then it fine-tunes on your clicks every 100 clicks, in the background.

To compare the model with [Foresight](https://foresightjs.com), turn on **Show predictions** in the popup.

## What it stores

Everything stays in `chrome.storage.local` in your browser. Nothing is sent anywhere.

- `trace:` and `outcome:` records: one per click. You can export them as JSONL under **Advanced**.
- `training:` records: clicks from versions before 0.1.0 made while recording was off, kept for fine-tuning only. They are never exported.
- `personalModel`: your fine-tuned weights.
- `timeSaved`: the time prefetching saved. For each prefetched page you open, that's how long its prefetch took to its
  first response byte, minus what the page still waited after the click. The background times prefetches through
  `webRequest`, holding them in memory only.
- Settings, and the sites with prefetching off.

**Clear** in the popup deletes every click record, your fine-tuned weights and the time saved, so the default weights run again.

Traces are geometry only: cursor positions and target rectangles. They contain no URLs, page text or element contents.
See [PRIVACY.md](PRIVACY.md).

## Development

- `packages/extension/`: the extension.
- `packages/beeline/`: the model, target tracking and prefetching, which the extension imports.
- `eval/`: replays exported traces through the model and the baselines.
- `train/`: trains the model (Python, needs [uv](https://docs.astral.sh/uv/)).

`npm run watch` rebuilds on each change. `npm run playground` is a test page for the core that you can use without
reloading the extension.

Checks:

```
npm run typecheck
npm run build
npm test
```

`npm run eval -- data/<export>.jsonl` scores the predictors on an export, and `npm run train -- data/<export>.jsonl`
trains on one. See [AGENTS.md](AGENTS.md) for training and data details.

The Foresight baseline is ported from Foresight.js 4.3.0 (MIT). The default weights are trained on the AdSERP dataset
(Zenodo 15236546, CC BY 4.0).
