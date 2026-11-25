// Prefetch same-origin links before they're clicked, when beeline expects a click or the cursor rests on the link.

import { createBeeline } from "./index.ts";

export type PrefetchOptions = {
  /** The probability of a click within the next moment that prefetches a link. */
  prefetchAbove?: number;
  /** How long the cursor rests on a link before it's prefetched anyway, in ms. */
  hoverMs?: number;
};

/**
 * Function to tell whether a link goes to another page on this site, so it's worth prefetching.
 * @param link The link.
 * @returns True for a same-origin http(s) link to another page that isn't a download.
 */
function isPrefetchable(link: HTMLAnchorElement): boolean {
  const samePage = link.href.split("#")[0] === location.href.split("#")[0];
  return link.origin === location.origin && link.protocol.startsWith("http") && !samePage && !link.hasAttribute("download");
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
