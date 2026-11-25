import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrefetchableUrl } from "../packages/beeline/src/prefetch.ts";

const page = new URL("https://example.com/docs/intro?tab=1#top");
const prefetchable = (href: string) => isPrefetchableUrl(new URL(href, page), page);

test("isPrefetchableUrl allows other pages on the same origin", () => {
  assert.ok(prefetchable("/docs/setup"));
  assert.ok(prefetchable("/docs/intro?tab=2"));
  assert.ok(prefetchable("/address-book"), "action words only count as whole words");
  assert.ok(prefetchable("/blog/carton-recycling"));
});

test("isPrefetchableUrl skips other origins, other schemes and the current page", () => {
  assert.ok(!prefetchable("https://other.com/docs/setup"));
  assert.ok(!prefetchable("http://example.com/docs/setup"));
  assert.ok(!prefetchable("javascript:void(0)"));
  assert.ok(!prefetchable("mailto:hi@example.com"));
  assert.ok(!prefetchable("#section"));
  assert.ok(!prefetchable("/docs/intro?tab=1"));
});

test("isPrefetchableUrl skips URLs that look like actions", () => {
  for (const href of ["/logout", "/log-out", "/users/sign_out", "/signout", "/items/4/delete", "/remove?id=4", "/unsubscribe", "/cart", "/cart/add?item=4", "/orders/confirm", "/verify?token=abc"]) {
    assert.ok(!prefetchable(href), href);
  }
});
