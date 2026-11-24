# beeline

beeline is a Chrome extension that predicts which element your cursor moves to. It also learns how you move.

beeline is a work in progress and a proof of concept. It is not on the Chrome Web Store.

## Layout

- `packages/beeline/`: the library. It tracks the cursor and the clickable elements on a page, and gives each
  element's chance of being clicked in the next moment.
- `packages/extension/`: the Chrome extension. It records click traces and draws the predictions over the page.
- `eval/`: replays recorded traces through the model and the baselines.
- `train/`: trains the model (Python).

## Run it

The repo does not include trained weights, because the weights fit the cursor movement of one person.
You record your own traces with the extension, then you train a model on them.
Training needs [uv](https://docs.astral.sh/uv/).

### Load the extension

1. Install the packages: `npm install`.
2. Copy the random test weights to `packages/beeline/src/model-weights.json`. The build needs a weights file:

   ```sh
   node -e 'const fs = require("fs"); fs.writeFileSync("packages/beeline/src/model-weights.json", JSON.stringify(JSON.parse(fs.readFileSync("test/model-fixture.json")).weights))'
   ```

3. Build the extension: `npm run build`.
4. Open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked** and select `packages/extension/dist/`.

### Record traces

1. Open the extension popup and make sure that **Record clicks** is on. It is on by default.
2. Use the browser as usual. The extension records each click.
3. When you have some clicks, click **Export** in the popup.
4. Move the exported `.jsonl` file into `data/`.

More clicks give a better model. The current numbers below come from about 3,200 clicks.

### Train the model

1. Train the model: `npm run train -- data/<export>.jsonl`. This command writes `packages/beeline/src/model-weights.json`.
2. Build the extension again: `npm run build`.
3. On `chrome://extensions`, click reload on the extension card.

To rebuild after each code change, use `npm run watch`.

In the popup, turn on **Show predictions** to outline the targets that a predictor fires on. You can select the
model or [Foresight](https://foresightjs.com). The model fires on a target when its probability is more than a
threshold. You set the threshold in the popup. The default is 80%. The popup can also show all targets.

## Current numbers

These numbers will change as the data and the model change. To get them from your own export, run
`npm run eval -- data/<export>.jsonl`.

### Data and model

- One person's export: 5,212 traces on 16 viewport sizes, with 3,175 clicks where the cursor moved onto the target.
  The model trains on the oldest 80% (2,540 clicks) and is tested on the newest 20% (635 clicks).
- Other people: the public [AdSERP dataset](https://zenodo.org/records/15236546) (47 people on search result pages,
  CC BY 4.0), converted with `npm run convert-adserp`. The model trains on 37 people and is tested on the other 10
  (371 clicks). AdSERP is one layout on one screen size, so it counts twice per click, not more.
  Train on both with `npm run train -- data/<export>.jsonl --adserp data/adserp-traces.jsonl`.
- The model is one small neural network with 128 hidden units. It scores each target on the page. A softmax over the
  targets plus a "no click" option gives each target's chance of being clicked within 650 ms.
- Probabilities are calibrated: of the predictions near 0.55, 55% were clicked within 650 ms. On the 10 people the model
  did not see, the mean gap between predicted and actual rates is 0.03.

### Terms

- **Hit rate:** the percentage of clicks where the predictor fired on the target before the click.
- **Lead:** the time from the first fire on the target to the click.
- **Precision:** the percentage of fires that were on the target that the user clicked.
- **Wasted fires:** fires on targets that the user did not click. Each wasted fire is a wasted prefetch.

### Predictors

The model fires at a threshold picked to match Foresight's precision or Foresight's lead.

| predictor | test clicks | hit rate | lead ms, median (p25-p75) | precision | wasted fires per click |
|---|---|---|---|---|---|
| hover | one person (635) | 99% | 319 (186-617) | 23% | 3.3 |
| foresight | one person (635) | 100% | 496 (325-789) | 16% | 5.4 |
| model, p ≥ 0.08 (Foresight's precision) | one person (635) | 99% | **584** (399-864) | 16% | 5.1 |
| model, p ≥ 0.16 (Foresight's lead) | one person (635) | 99% | 502 (326-790) | **25%** | **2.9** |
| hover | 10 other people (371) | 73% | 463 (282-697) | 44% | 0.9 |
| foresight | 10 other people (371) | 90% | 639 (447-811) | 40% | 1.4 |
| model, p ≥ 0.14 (Foresight's precision) | 10 other people (371) | 100% | **741** (542-932) | 41% | 1.5 |
| model, p ≥ 0.34 (Foresight's lead) | 10 other people (371) | 99% | 639 (461-833) | **65%** | **0.5** |

- At the same precision as Foresight, the model fires 90-100 ms earlier.
- At the same lead as Foresight, the model wastes about half as many prefetches on one person, and a third as many on
  the 10 other people.
- The top guess of the model is correct on 61% of one person's clicks at 300 ms before the click, 80% at 200 ms, and
  91% at 100 ms. On search result pages, it is correct on 98% at 300 ms.

### Time saved and bandwidth

A hit saves the lead time or the fetch time, whichever is shorter. The table uses three fetch times.
It assumes 30 KB for each HTML prefetch and 2 MB for each prerender. All values are for one person's 635 test clicks.

| predictor | hit rate | precision | ms saved per click at 150 / 400 / 1000 ms fetch | wasted per click, prefetch / prerender |
|---|---|---|---|---|
| hover | 99% | 23% | 145 / 292 / 421 | 100 KB / 6.6 MB |
| foresight | 100% | 16% | 150 / 357 / 555 | 163 KB / 10.8 MB |
| model, p ≥ 0.1 | 99% | 19% | 148 / 370 / 605 | 130 KB / 8.7 MB |
| model, p ≥ 0.2 | 98% | 30% | 147 / 338 / 508 | 69 KB / 4.6 MB |
| model, p ≥ 0.3 | 95% | 42% | 141 / 305 / 442 | 39 KB / 2.6 MB |
| model, p ≥ 0.5 | 87% | 63% | 122 / 241 / 330 | 15 KB / 1.0 MB |
| model, p ≥ 0.8 | 52% | 86% | 68 / 124 / 162 | 2 KB / 164 KB |

- On link clicks that navigated (104 test clicks), the model at Foresight's lead is correct on 33% of fires.
  Foresight is correct on 24%.
- At p ≥ 0.1, the model saves 50 ms more per click than Foresight on a 1 s fetch, with 20% less waste.
- At p ≥ 0.3, the model saves more time than hover on fetches of 400 ms and more, with 60% less waste.
- Set the threshold from the cost of a fire. Use a low threshold for an HTML prefetch and a high threshold for a prerender.

### Model size

This table is from an earlier version of the model, which shared each click across the targets, on an export of
1,867 clicks. It shows the loss on the test clicks. A lower loss is better. Each run trains on the newest 25%, 50%,
or 100% of the training clicks, with the same number of steps.

| hidden units | 374 clicks | 747 clicks | 1,494 clicks |
|---|---|---|---|
| 8 | 1.361 | 1.302 | 1.280 |
| 32 | 1.334 | 1.266 | 1.240 |
| 128 | 1.304 | 1.233 | 1.192 |

- More data continues to help, but each doubling helps less. The largest model gets the most from each doubling.
- With 128 units, the model takes about 0.5 ms per frame on a page with 200 targets.

### Limits

- The recorded data comes from one person on one device, plus AdSERP's 47 people on one kind of page.
- Every trace ends in a click, so on real pages, where most movement clicks nothing, probabilities read high.
  A target alone on the page reaches 0.5 in 47% of moves toward a different target.
- If a link is in a clickable card, a click on the link counts the card as a wasted fire. This applies to all predictors.
- Clicks less than 1 s apart share samples. Thus, the eval counts some movement two times.
- Each trace keeps about 1 s of history. The lead time cannot be longer than this history.

## Privacy

All data stays in your browser. The recorded traces contain only cursor positions and target rectangles.
They do not contain URLs or page content.
