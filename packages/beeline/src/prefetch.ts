// Prefetch same-origin links before they're clicked, when beeline expects a click or the cursor rests on the link.

import { createBeeline } from "./index.ts";

export type PrefetchOptions = {
  /** The probability of a click within the next moment that prefetches a link. */
  prefetchAbove?: number;
  /** How long the cursor rests on a link before it's prefetched anyway, in ms. */
  hoverMs?: number;
};

// Words in a path or query that suggest opening the link does something, like signing out or emptying a cart.
const ACTION_WORDS = /(?<![a-z])(log[-_]?out|sign[-_]?out|delete|remove|unsubscribe|cart|add|confirm|token)(?![a-z])/i;

/**
 * Function to tell whether a URL is safe and worth prefetching from a page: another page on the same origin, whose
 * path and query don't look like an action.
 * @param url The link's URL.
 * @param pageUrl The current page's URL.
 * @returns True if the URL can be prefetched.
 */
export function isPrefetchableUrl(url: URL, pageUrl: URL): boolean {
  const samePage = url.href.split("#")[0] === pageUrl.href.split("#")[0];
  return url.origin === pageUrl.origin && /^https?:$/.test(url.protocol) && !samePage && !ACTION_WORDS.test(url.pathname + url.search);
}

/**
 * Function to tell whether a link is worth prefetching: not a download, on a page without its own speculation rules,
 * and to a prefetchable URL.
 * @param link The link.
 * @returns True if the link can be prefetched.
 */
function isPrefetchable(link: HTMLAnchorElement): boolean {
  const pageHasOwnRules = document.querySelector('script[type="speculationrules"]:not([data-beeline])') !== null;
  return !link.hasAttribute("download") && !pageHasOwnRules && isPrefetchableUrl(new URL(link.href), new URL(location.href));
}

/**
 * Function to prefetch a URL with a speculation rule, or with `<link rel="prefetch">` where those aren't supported.
 * @param url The URL.
 * @returns Nothing.
 */
function prefetchUrl(url: string): void {
  if (HTMLScriptElement.supports?.("speculationrules")) {
    const rule = document.createElement("script");
    rule.type = "speculationrules";
    rule.dataset.beeline = "";
    rule.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [url] }] });
    document.head.append(rule);
  } else {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    document.head.append(link);
  }
}

/**
 * Function to prefetch each same-origin link once, when beeline expects it to be clicked, the cursor rests on it, it
 * gets keyboard focus, or a touch starts on it. Covers links added later too.
 * @param options The threshold and the hover floor.
 * @returns A function that stops.
 */
export function prefetchLinks({ prefetchAbove = 0.4, hoverMs = 100 }: PrefetchOptions = {}): () => void {
  const prefetchedUrls = new Set<string>();
  const prefetchOnce = (link: HTMLAnchorElement) => {
    if (prefetchedUrls.has(link.href) || !isPrefetchable(link)) return;
    prefetchedUrls.add(link.href);
    prefetchUrl(link.href);
  };

  const beeline = createBeeline({ cssVariable: false });
  beeline.onFrame(({ targetElements, probabilities }) => {
    probabilities.forEach((probability, index) => {
      const link = targetElements[index];
      if (link instanceof HTMLAnchorElement && probability >= prefetchAbove) prefetchOnce(link);
    });
  });

  const listening = new AbortController();
  const listenerOptions = { capture: true, passive: true, signal: listening.signal };
  const closestLink = (event: Event) => {
    const link = (event.target as Element).closest?.("a[href]");
    return link instanceof HTMLAnchorElement ? link : undefined;
  };
  // Keyboard focus (not the focus a mouse click gives), and a touch, which has no cursor to predict from.
  addEventListener(
    "focusin",
    (event) => {
      const link = closestLink(event);
      if (link && (event.target as Element).matches(":focus-visible")) prefetchOnce(link);
    },
    listenerOptions,
  );
  addEventListener(
    "pointerdown",
    (event) => {
      const link = closestLink(event);
      if (link && event.pointerType !== "mouse") prefetchOnce(link);
    },
    listenerOptions,
  );
  // Hover floor: a link the cursor rests on is prefetched even if beeline hasn't reached the threshold.
  let hoverTimer: number | undefined;
  addEventListener(
    "pointerover",
    (event) => {
      const link = closestLink(event);
      if (event.pointerType !== "mouse" || !link) return;
      clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => prefetchOnce(link), hoverMs);
    },
    listenerOptions,
  );
  addEventListener("pointerout", () => clearTimeout(hoverTimer), listenerOptions);

  return () => {
    beeline.destroy();
    listening.abort();
    clearTimeout(hoverTimer);
  };
}
