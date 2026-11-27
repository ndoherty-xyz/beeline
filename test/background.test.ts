import assert from "node:assert/strict";
import { test } from "node:test";
import { PERSONAL_MODEL_VERSION, type PersonalModel } from "../packages/extension/src/personal-model.ts";
import defaultWeights from "../packages/beeline/src/default-weights.json" with { type: "json" };
import type { Trace } from "../packages/beeline/src/traces.ts";

let storage: Record<string, unknown> = { newUsableClickCount: 0 };
let clearOnTraceRead = false;
const listeners = { addListener() {} };
Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          if (clearOnTraceRead && typeof keys === "string" && keys.startsWith("trace:")) storage = {};
          return Object.fromEntries([keys].flat().filter(key => key in storage).map(key => [key, storage[key]]));
        },
        set: async (items: Record<string, unknown>) => Object.assign(storage, items),
        remove: async (key: string) => delete storage[key],
        getKeys: async () => Object.keys(storage),
      },
      onChanged: listeners,
    },
    webRequest: { onSendHeaders: listeners, onResponseStarted: listeners },
    runtime: { onMessage: listeners },
  },
});
const { countClicksAndFineTune } = await import("../packages/extension/src/background.ts");

/**
 * Function to seed storage with a legacy model and usable clicks.
 * @param count Number of stored clicks.
 * @returns Nothing.
 */
function seedLegacyModel(count: number): void {
  const weights = { ...defaultWeights, hiddenWeights: Array(128).fill(defaultWeights.hiddenWeights[0]),
    hiddenBiases: Array(128).fill(0), outputWeights: Array(128).fill(0) };
  storage = { personalModel: { weights, clickCount: 900, learnedUntil: 900 }, newUsableClickCount: 0 };
  clearOnTraceRead = false;
  for (let time = 1; time <= count; time++) {
    storage[`trace:${time}`] = {
      time, viewport: [200, 200], targets: [[40, 40, 20, 20]], clicked: 0, pointerCursor: false,
      samples: [[-50, 20, 20, 20, 20, 1], [-10, 45, 45, 45, 45, 1]],
    } satisfies Trace;
  }
}

test("migration rebuilds a 32-unit model from all stored clicks even with the counter at zero", async () => {
  seedLegacyModel(101);
  await countClicksAndFineTune([]);
  const model = storage.personalModel as PersonalModel;
  assert.equal(model.version, PERSONAL_MODEL_VERSION);
  assert.equal(model.weights.hiddenBiases.length, 32);
  assert.equal(model.clickCount, 101);
  assert.equal(model.learnedUntil, 101);
  assert.equal(storage.newUsableClickCount, 0);
  assert.equal(Object.keys(storage).filter(key => key.startsWith("trace:")).length, 101);
});

test("migration keeps 99 clicks toward the first update", async () => {
  seedLegacyModel(99);
  await countClicksAndFineTune([]);
  assert.equal(storage.personalModel, undefined);
  assert.equal(storage.newUsableClickCount, 99);
  assert.equal(Object.keys(storage).filter(key => key.startsWith("trace:")).length, 99);
});

test("clearing clicks during an update discards the trained model", async () => {
  seedLegacyModel(100);
  clearOnTraceRead = true;
  await countClicksAndFineTune([]);
  assert.deepEqual(storage, {});
});
