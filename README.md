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

A 544-parameter model trained on one person's trackpad clicks, scored offline on the newest 373 clicks it
never saw, against [Foresight](https://foresightjs.com) and plain hover:

| predictor | precision | median lead before the click | ms saved per click at 400 / 1000 ms fetch |
|---|---|---|---|
| hover | 28% | 361 ms | 304 / 421 |
| foresight | 20% | 512 ms | 361 / 549 |
| model, p ≥ 0.18 | 20% | 642 ms | 378 / 650 |
| model, p ≥ 0.37 | 36% | 522 ms | 350 / 552 |

- At Foresight's precision, the model fires 130 ms earlier.
- At Foresight's lead, it's right 36% of the time instead of 20%, so it wastes half as many prefetches.
- Its top guess is right 75% of the time 300 ms before the click.

It's one person and one device so far. Details, and how fetch times and bandwidth are assumed, are in
[docs/results.md](docs/results.md).

## Privacy

Everything stays in your browser. Recorded traces contain cursor positions and target rectangles only:
no URLs and no page content.
