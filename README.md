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
After a rebuild, press reload on the extension card. **Show predictions** in the popup draws the model's
probability for each target, with a percentage once one passes 50%.

Everything stays in your browser. Recorded traces contain cursor positions and target rectangles only:
no URLs and no page content.
