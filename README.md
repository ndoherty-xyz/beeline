# beeline

A Chrome extension that predicts which element your cursor is heading for, and learns how you move.
It's a proof of concept, so it isn't on the Chrome Web Store. See [docs/prd.md](docs/prd.md) for the concept and plan.

## Run it

The trained weights aren't in the repo (they're fitted to one person's cursor movement), so train your own
from an export of recorded traces first. Training needs [uv](https://docs.astral.sh/uv/).

```sh
npm install
npm run train -- data/<export>.jsonl   # writes src/model-weights.json
npm run build                          # or: npm run watch
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `dist/`.
After a rebuild, press reload on the extension card. **Show predictions** in the popup outlines the targets a
predictor fires on: the model (at a threshold you set, 80% by default) or Foresight. It can also show every target.

## Results so far

A 2,176-parameter model trained on one person's trackpad clicks, scored offline on the newest 373 clicks it
never saw, against [Foresight](https://foresightjs.com) and plain hover. The model fires on a target once its
probability passes a threshold, so one model gives a range of tradeoffs:

| predictor | hit rate | precision | wasted prefetches per click | median lead before the click | ms saved per click at 400 / 1000 ms fetch |
|---|---|---|---|---|---|
| hover | 99% | 28% | 2.5 | 361 ms | 304 / 421 |
| foresight | 99% | 20% | 3.9 | 512 ms | 361 / 549 |
| model, p ≥ 0.17 (Foresight's precision) | 100% | 20% | 3.9 | **659 ms** | **377 / 654** |
| model, p ≥ 0.36 (Foresight's lead) | 99% | **36%** | **1.8** | 520 ms | 356 / 566 |
| model, p ≥ 0.5 | 95% | 46% | 1.1 | 451 ms | 324 / 484 |
| model, p ≥ 0.8 | 83% | 73% | 0.3 | 311 ms | 238 / 315 |

**Hit rate** is the share of clicks whose target was fired on beforehand, and **precision** the share of fires
that were the target clicked. Each miss is a wasted prefetch.

- **Matched to Foresight's precision, the model fires 150 ms earlier,** saving 105 ms more per click on a 1 s page.
- **Matched to Foresight's lead, it's right 36% of the time instead of 20%,** and wastes half as many prefetches.
- **At 50% it still saves more time than hover,** with less than half hover's waste.
- **At 80% it fires before 83% of clicks and is right 73% of the time,** cheap enough to prerender.
- Its top guess is right 75% of the time 300 ms before the click, and 94% at 100 ms.

It's one person and one device so far. Details, and how fetch times and bandwidth are assumed, are in
[docs/results.md](docs/results.md).

## Privacy

Everything stays in your browser. Recorded traces contain cursor positions and target rectangles only:
no URLs and no page content.
