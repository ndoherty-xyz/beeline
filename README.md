# beeline

A Chrome extension that predicts which element your cursor is heading for, and learns how you move.
It's a proof of concept, so it isn't on the Chrome Web Store. See [docs/prd.md](docs/prd.md) for the concept and plan.

## Run it

```sh
npm install
npm run build     # or: npm run watch
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `dist/`.
After a rebuild, press reload on the extension card.

Everything stays in your browser. Recorded traces contain cursor positions and target rectangles only:
no URLs and no page content.
