# beeline

beeline is a Chrome extension that predicts which element your cursor moves to. It also learns how you move.

beeline is a work in progress and a proof of concept. It is not on the Chrome Web Store.

## Run it

The repo does not include trained weights, because the weights fit the cursor movement of one person.
You record your own traces with the extension, then you train a model on them.
Training needs [uv](https://docs.astral.sh/uv/).

### Load the extension

1. Install the packages: `npm install`.
2. Copy the random test weights to `src/model-weights.json`. The build needs a weights file:

   ```sh
   node -e 'const fs = require("fs"); fs.writeFileSync("src/model-weights.json", JSON.stringify(JSON.parse(fs.readFileSync("test/model-fixture.json")).weights))'
   ```

3. Build the extension: `npm run build`.
4. Open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked** and select `dist/`.

### Record traces

1. Open the extension popup and make sure that **Record clicks** is on. It is on by default.
2. Use the browser as usual. The extension records each click.
3. When you have some clicks, click **Export** in the popup.
4. Move the exported `.jsonl` file into `data/`.

More clicks give a better model. The current numbers below come from about 1,900 clicks.

### Train the model

1. Train the model: `npm run train -- data/<export>.jsonl`. This command writes `src/model-weights.json`.
2. Build the extension again: `npm run build`.
3. On `chrome://extensions`, click reload on the extension card.

To rebuild after each code change, use `npm run watch`.

In the popup, turn on **Show predictions** to outline the targets that a predictor fires on. You can select the
model or [Foresight](https://foresightjs.com). The model fires on a target when its probability is more than a
threshold. You set the threshold in the popup. The default is 80%. The popup can also show all targets.

## Current numbers

These numbers are from one person on one trackpad. They will change as the data and the model change.

To get the numbers from your own export, run `npm run eval -- data/<export>.jsonl`.

### Data and model

- The export has 2,989 traces from three days, on 11 viewport sizes.
- The eval scores 1,867 clicks where the cursor moved onto the target.
- The model trains on the oldest 80% of these clicks (1,494).
- The tests use the newest 20% (373 clicks). The model did not see these clicks during training.
- The model is one small neural network with 128 hidden units and 2,176 parameters.
- The network scores each target on the page. A softmax across the targets gives the probabilities.

### Terms

- **Hit rate:** the percentage of clicks where the predictor fired on the target before the click.
- **Lead:** the time from the first fire on the target to the click.
- **Precision:** the percentage of fires that were on the target that the user clicked.
- **Wasted fires:** fires on targets that the user did not click. Each wasted fire is a wasted prefetch.

### Predictors

All values are for the 373 test clicks.

| predictor | hit rate | lead ms, median (p25-p75) | precision | wasted fires per click |
|---|---|---|---|---|
| hover | 99% | 361 (211-557) | 28% | 2.5 |
| getPredictedEvents | 99% | 432 (273-659) | 24% | 3.1 |
| foresight | 99% | 512 (354-728) | 20% | 3.9 |
| model, p ≥ 0.17 (Foresight's precision) | 100% | **659** (443-896) | 20% | 3.9 |
| model, p ≥ 0.36 (Foresight's lead) | 99% | 520 (351-793) | **36%** | **1.8** |

- At the same precision as Foresight, the model fires 150 ms earlier.
- At the same lead as Foresight, the model is correct on 36% of fires. Foresight is correct on 20%.
- At the same lead, the model wastes half as many prefetches as Foresight.
- The top guess of the model is correct on 75% of clicks at 300 ms before the click.
  At 200 ms, it is correct on 87%. At 100 ms, it is correct on 94%.

### Time saved and bandwidth

A hit saves the lead time or the fetch time, whichever is shorter. The table uses three fetch times.
It assumes 30 KB for each HTML prefetch and 2 MB for each prerender.

| predictor | hit rate | precision | ms saved per click at 150 / 400 / 1000 ms fetch | wasted per click, prefetch / prerender |
|---|---|---|---|---|
| hover | 99% | 28% | 145 / 304 / 421 | 76 KB / 5.1 MB |
| foresight | 99% | 20% | 149 / 361 / 549 | 116 KB / 7.8 MB |
| model, p ≥ 0.17 | 100% | 20% | 149 / 377 / 654 | 116 KB / 7.8 MB |
| model, p ≥ 0.3 | 100% | 31% | 149 / 365 / 597 | 68 KB / 4.5 MB |
| model, p ≥ 0.5 | 95% | 46% | 141 / 324 / 484 | 34 KB / 2.3 MB |
| model, p ≥ 0.7 | 87% | 64% | 128 / 272 / 372 | 15 KB / 971 KB |
| model, p ≥ 0.8 | 83% | 73% | 119 / 238 / 315 | 9 KB / 627 KB |

- The longer lead of the model helps most on slow pages. On a 1 s fetch, it saves 105 ms more per click than Foresight.
- On a 400 ms fetch, the gain is only 16 ms, because most leads are already longer than the fetch.
- On typical pages, the model saves bandwidth. At p ≥ 0.3, it saves the same time as Foresight with 41% less waste.
- At p ≥ 0.5, the model saves more time than hover at all fetch times above 150 ms. It also wastes 55% less.
- Set the threshold from the cost of a fire. Use a low threshold for an HTML prefetch and a high threshold for a prerender.

### Model size

This table shows the loss on the test clicks. A lower loss is better. Each run trains on the newest 25%, 50%,
or 100% of the training clicks, with the same number of steps.

| hidden units | 374 clicks | 747 clicks | 1,494 clicks |
|---|---|---|---|
| 8 | 1.361 | 1.302 | 1.280 |
| 32 | 1.334 | 1.266 | 1.240 |
| 128 | 1.304 | 1.233 | 1.192 |

- More data continues to help, but each doubling helps less. The largest model gets the most from each doubling.
- With 128 units, the model takes about 0.5 ms per frame on a page with 200 targets.

### Limits

- All data comes from one person on one device.
- If a link is in a clickable card, a click on the link counts the card as a wasted fire. This applies to all predictors.
- Clicks less than 1 s apart share samples. Thus, the eval counts some movement two times.
- Each trace keeps about 1 s of history. The lead time cannot be longer than this history.

## Privacy

All data stays in your browser. The recorded traces contain only cursor positions and target rectangles.
They do not contain URLs or page content.
