# Archive Search

A fast, clean web app for searching the [Internet Archive](https://archive.org) —
books, movies, music, software, images and data — built on the Archive's public
[advancedsearch API](https://archive.org/advancedsearch.php).

**100% client-side:** no build step, no dependencies, no server. Open `index.html`
or serve the folder statically and it just works.

## Run it

```bash
node server.js        # http://0.0.0.0:8080  (recommended — see below)
```

The site also works from any static file server (e.g. `python3 -m http.server`),
but `server.js` adds:

- **`GET /api/search`** — a same-origin relay to archive.org, so the page can
  search with zero CORS and no third-party proxies when the server has
  internet access
- **`POST /api/log`** — anonymous connectivity diagnostics from the page
  (written to `diagnostics.log`, which is gitignored) to make "can't search"
  problems diagnosable

## How searching works (multi-route fallback)

Some environments (notably sandboxed preview iframes) block cross-origin
`fetch` even though archive.org itself sends CORS headers. Each search
therefore tries several routes in order and remembers the first that works:

1. `relay` — same-origin `/api/search` on `server.js` (best when self-hosting)
2. `direct` — `https://archive.org/advancedsearch.php`
3. mirror proxies as last resort: `corsproxy.io`, `allorigins.win`, `codetabs.com`

If every route fails, the error state shows exactly which routes were tried
and why (including any Content-Security-Policy violations), and reports the
same details to `/api/log` when the app server is running.

## Features

- 🔍 Full-text search across every Internet Archive media type
- 🎛️ Media-type filters (audio, video, books, software, images, data) and sorting
  (relevance, downloads, date added, year)
- 📄 Pagination with 24 results per page
- 🔗 Shareable URLs — query, filter, sort and page are stored in the address bar
  (`?q=apollo&type=video&sort=downloads&page=2`), survive refresh, and work with
  the browser's back/forward buttons
- 🌗 Dark/light theme that follows your OS preference (with a manual override)
- ⌨️ Keyboard shortcut: press <kbd>/</kbd> to jump to the search box
- 📱 Responsive, accessible (ARIA live regions, focus states, reduced-motion support)

## Structure

| File          | Purpose                                  |
| ------------- | ---------------------------------------- |
| `index.html`  | Markup and page structure                |
| `styles.css`  | Design system (themes, layout, states)   |
| `app.js`      | Search logic, rendering, state, routing  |
| `server.js`   | Zero-dependency Node server (static + API relay + diagnostics) |
| `favicon.svg` | Site icon                                |

## Notable correctness details

- Every API-supplied string is HTML-escaped before rendering (no XSS).
- In-flight requests are aborted when a new search starts, so stale responses
  can never overwrite fresh results.
- HTTP errors, network failures, timeouts and malformed payloads each produce a
  clear error state with a retry button.
- Archive.org fields that may arrive as arrays or `";"`-joined strings
  (title, creator, year) are normalized before display.
- Requests time out after 25 s instead of hanging forever.

## License

Unlicense-style: do whatever you like. Data and thumbnails come from the
Internet Archive and belong to their respective rightsholders. This project is
not affiliated with archive.org.
