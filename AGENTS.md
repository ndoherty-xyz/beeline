# Working in this repo

Start with [docs/prd.md](docs/prd.md): the concept, the design, and the milestones in order. Then
[docs/results.md](docs/results.md): what the recorded data looks like and the current numbers.

`packages/beeline/` is the library (core API in `src/index.ts`, the model in `src/model.ts`). `packages/extension/` is
the Chrome extension, which imports the core as `beeline` through npm workspaces. `eval/`, `train/` and `test/` stay at
the root and cover both.

Traces are exported from the popup as JSONL. The current export is in `data/` (gitignored, never commit it).

## Writing code

- **Use built-in types over custom classes.** Don't write a class that only wraps a collection plus a
  rule for adding to it. Use a `Map`/`Set`/array and one plain function.
- **Inline single-use helpers.** If a function is called from one place and its name doesn't explain
  more than its body, put the body where it's used (with a one-line comment if the code isn't
  self-explanatory).
- **Name things explicitly.** Function names say what they do and to what (`refreshTargetRects`, not
  `refresh`); variables say what they hold (`targetRects`, not `rects` when there are several kinds).
- **JSDoc every function, briefly.** One line starting "Function to ...", then `@param` for each
  argument and `@returns`. Say what, not how. TypeScript only; Python keeps its docstrings.
- **Reuse before adding.** Before a new type or helper, check whether existing data or an existing
  helper can carry the case.
- **Write code for the data you actually have.** Don't filter or guard against cases the data can't
  produce. Prefer regex literals over `String.raw`/escaped strings.
- **Split longer files into sections** with separator comments (`// Overlay ----------`), helpers above
  the main function they serve.
- **Keep the first version simple.** Write the smallest thing that works, then explain it. Ask before
  adding layers rather than making the user untangle them.

## Comments

Keep them short. A one- or two-line comment on a genuinely confusing part is worth writing; a
paragraph explaining the reasoning behind a design decision is not. Notes on *why* a number or an
experiment turned out the way it did belong in `docs/`, not above the code.

Do not restate what the code says, and do not narrate a change. Git history covers that.

## Scope

- The overlay can switch between the model and Foresight, to compare how they feel in use. Numbers come only
  from offline comparisons over recorded traces, never from the extension.
- Keep `packages/extension/src/baselines.ts` and `packages/beeline/src/model.ts` pure (no DOM, no `chrome.*`) so traces can be replayed through them in Node.
- Traces are geometry only. Never store URLs, page text, element contents or selectors.
- Inference runs on the CPU in plain TypeScript. No WebGPU.

## Checks

```
npm run typecheck
npm run build
npm test
```

Tests use `node --test`; Node 22.18+ runs `.ts` tests directly.

Training is Python (numpy, managed by uv in `train/`): `npm run train -- data/<export>.jsonl` rewrites
`packages/beeline/src/model-weights.json` (gitignored: it's fitted to personal movement, never commit it) and
`test/model-fixture.json` (random weights, so the parity test needs no trained model) together. `train/beeline_model.py` mirrors
`packages/beeline/src/model.ts`; change both, then retrain so the fixture matches.

Public data: `npm run convert-adserp -- <unzipped AdSERP dir> data/adserp-traces.jsonl` turns the AdSERP dataset
(Zenodo 15236546, CC BY 4.0) into traces from 47 other people, with a `person` field for holding people out. Download
its `mouse-movement-data`, `trial-metadata` and `serps` zips one at a time, and `npx playwright install chromium` once.
