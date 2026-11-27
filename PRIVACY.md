# Privacy

beeline keeps everything on your device.

- **What it stores:** cursor geometry and clicks (cursor positions over time, the rectangles of clickable elements,
  and which one you clicked), the weights it fine-tunes from them, the total time prefetching saved, and your settings. All of it is in
  `chrome.storage.local`, in your browser.
- **What it doesn't store:** URLs, page text, element contents, or anything else from the pages you visit.
- **Request timing:** to add up the time saved, beeline times its prefetch requests as they happen. It holds each
  prefetch's address and timing in memory only until you open that page or the extension idles, and never stores them.
- **Chrome settings:** beeline reads whether Chrome's page preloading is on, to warn you when it's off. It never
  changes it.
- **What it sends:** nothing. beeline has no server and makes no requests of its own.
- **Prefetches** are ordinary requests to the site you're on, for pages on the same origin, the same as a click would
  make a moment later. They go only to that site.
- **Reset beeline**, under Advanced in the popup, deletes every stored click, the fine-tuned weights and the time saved. Removing the extension deletes
  everything, settings included.

Exported traces are files you save yourself; beeline doesn't send them anywhere.
