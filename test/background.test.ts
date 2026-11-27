import assert from "node:assert/strict";
import { test } from "node:test";
import type { Trace } from "../packages/beeline/src/traces.ts";

let storage: Record<string, unknown> = { newUsableClickCount: 0 };
const listeners = { addListener() {} };
Object.assign(globalThis, {
  chrome: {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          if (typeof keys === "string" && keys.startsWith("trace:")) storage = {};
          return Object.fromEntries([keys].flat().filter(key => key in storage).map(key => [key, storage[key]]));
        },
        set: async (items: Record<string, unknown>) => Object.assign(storage, items),
        getKeys: async () => Object.keys(storage),
      },
      onChanged: listeners,
    },
    webRequest: { onSendHeaders: listeners, onResponseStarted: listeners },
    runtime: { onMessage: listeners },
  },
});
const { countClicksAndFineTune } = await import("../packages/extension/src/background.ts");

test("clearing clicks during an update discards the trained model", async () => {
  for (let time = 1; time <= 100; time++) {
    storage[`trace:${time}`] = {
      time, viewport: [200, 200], targets: [[40, 40, 20, 20]], clicked: 0, pointerCursor: false,
      samples: [[-50, 20, 20, 20, 20, 1], [-10, 45, 45, 45, 45, 1]],
    } satisfies Trace;
  }
  storage.newUsableClickCount = 100;
  await countClicksAndFineTune([]);
  assert.deepEqual(storage, {});
});
