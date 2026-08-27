/* ==========================================================================
   Archive Search — application logic

   Talks to the Internet Archive's public advancedsearch API from the browser.

   Fetch routes ("transports")
   ---------------------------
   Some environments block direct cross-origin requests (e.g. sandboxed
   preview iframes with a Content-Security-Policy), even though archive.org
   itself sends CORS headers. So each search tries several routes in order
   and remembers the first one that works:

     1. relay      — same-origin /api/search on this repo's server (server.js);
                     best option when self-hosting (no CORS, no third parties)
     2. direct     — https://archive.org/advancedsearch.php (works on normal
                     hosting — archive.org sends Access-Control-Allow-Origin: *)
     3. corsproxy.io, allorigins.win, codetabs.com — public mirror proxies as
                     last-resort fallbacks

   Other key behaviours:
   - All API-supplied strings are HTML-escaped before rendering (no XSS).
   - In-flight requests are aborted when a new one starts (no stale results).
   - HTTP errors, timeouts, malformed payloads and network failures each get
     a clear, recoverable error state with technical details.
   - Search state (query / media type / sort / page) is mirrored in the URL,
     so results are shareable and survive refresh + back/forward.
   - Anonymous connectivity diagnostics are POSTed to /api/log when server.js
     is running, which makes connection problems diagnosable.
   ========================================================================== */
(() => {
    'use strict';

    /* ---------------- Configuration ---------------- */

    const API_URL = 'https://archive.org/advancedsearch.php';
    const DETAILS_URL = 'https://archive.org/details/';
    const THUMB_URL = 'https://archive.org/services/img/';

    const PAGE_SIZE = 24;            // results per page
    const SKELETON_COUNT = 12;       // placeholder cards while loading
    const REQUEST_TIMEOUT_MS = 45000;     // whole search, every route combined
    const TRANSPORT_TIMEOUT_MS = 8000;    // per route
    const PROBE_DELAY_MS = 1200;          // background connectivity check

    // Fields requested from the API to keep the payload light.
    const FIELDS = ['identifier', 'title', 'creator', 'mediatype', 'year', 'downloads'];

    // UI filter -> archive.org mediatype value (null = no filter).
    const MEDIA_TYPES = {
        all: null,
        audio: 'audio',
        video: 'movies',
        books: 'texts',
        software: 'software',
        images: 'images',
        data: 'data',
    };

    // UI sort -> archive.org sort clause (null = relevance).
    const SORTS = {
        relevance: null,
        downloads: 'downloads desc',
        added: 'publicdate desc',
        yearNew: 'year desc',
        yearOld: 'year asc',
    };

    const TYPE_LABELS = {
        audio: 'Audio',
        movies: 'Video',
        texts: 'Book',
        software: 'Software',
        images: 'Image',
        data: 'Data',
        web: 'Web',
        collection: 'Collection',
        etree: 'Live Music',
    };

    /* ---------------- Fetch routes (transports) ---------------- */

    const TRANSPORTS = [
        { id: 'relay', label: 'local server', build: (u) => '/api/search' + u.slice(u.indexOf('?')) },
        { id: 'direct', label: 'archive.org', build: (u) => u },
        { id: 'corsproxy', label: 'corsproxy.io', build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
        { id: 'allorigins', label: 'allorigins.win', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
        { id: 'codetabs', label: 'codetabs.com', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
    ];

    let preferredTransport = -1;   // index of the last route that worked
    try {
        const saved = parseInt(localStorage.getItem('as-transport'), 10);
        if (Number.isInteger(saved) && saved >= 0 && saved < TRANSPORTS.length) preferredTransport = saved;
    } catch (_) { /* storage unavailable in sandboxed iframes */ }

    function rememberTransport(idx) {
        if (preferredTransport === idx) return;
        preferredTransport = idx;
        try { localStorage.setItem('as-transport', String(idx)); } catch (_) { /* ignore */ }
    }

    function transportOrder() {
        const order = [];
        if (preferredTransport >= 0) order.push(preferredTransport);
        for (let i = 0; i < TRANSPORTS.length; i++) if (i !== preferredTransport) order.push(i);
        return order;
    }

    /* ---------------- Icons (inline SVG) ---------------- */

    const svg = (body) =>
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';

    const ICONS = {
        audio: svg('<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>'),
        movies: svg('<rect x="2" y="2" width="20" height="20" rx="2.5"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line>'),
        texts: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>'),
        software: svg('<rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line>'),
        images: svg('<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>'),
        data: svg('<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>'),
        web: svg('<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>'),
        collection: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line>'),
        etree: svg('<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>'),
        default: svg('<polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line>'),
    };

    /* ---------------- DOM ---------------- */

    const $ = (id) => document.getElementById(id);

    const els = {
        form: $('searchForm'),
        input: $('searchInput'),
        submitBtn: $('searchBtn'),
        submitLabel: $('searchBtn').querySelector('.btn-label'),
        submitSpinner: $('searchBtn').querySelector('.btn-spinner'),
        clearBtn: $('clearBtn'),
        themeToggle: $('themeToggle'),
        landing: $('landing'),
        status: $('status'),
        toolbar: $('toolbar'),
        typeGroup: $('typeGroup'),
        sortSelect: $('sortSelect'),
        grid: $('resultsGrid'),
        pagination: $('pagination'),
        empty: $('emptyState'),
        emptyQuery: $('emptyQuery'),
        error: $('errorState'),
        errorMessage: $('errorMessage'),
        diagDetails: $('diagDetails'),
        diagOutput: $('diagOutput'),
        retryBtn: $('retryBtn'),
        section: $('results'),
    };

    /* ---------------- State ---------------- */

    const state = { query: '', type: 'all', sort: 'relevance', page: 1 };

    let currentRequest = null;   // { controller, token, timedOut }
    let requestToken = 0;        // guards against rendering stale responses

    /* ---------------- Diagnostics ---------------- */

    const diag = { cspViolations: [] };

    // Capture CSP blocks (e.g. connect-src forbidding cross-origin fetch) so
    // they can be shown/reported instead of a generic "Failed to fetch".
    document.addEventListener('securitypolicyviolation', (e) => {
        try {
            diag.cspViolations.push({
                directive: e.violatedDirective,
                blocked: String(e.blockedURI || '').slice(0, 200),
            });
            if (diag.cspViolations.length > 10) diag.cspViolations.shift();
        } catch (_) { /* ignore */ }
    });

    function envSnapshot() {
        const env = {
            href: String(location.href || '').slice(0, 300),
            inIframe: false,
            online: !!(navigator && navigator.onLine),
            crossOriginIsolated: !!window.crossOriginIsolated,
            serviceWorker: !!(navigator && navigator.serviceWorker && navigator.serviceWorker.controller),
            ua: navigator ? String(navigator.userAgent || '').slice(0, 200) : '',
            cspViolations: diag.cspViolations.slice(),
        };
        try { env.inIframe = window.self !== window.top; } catch (_) { env.inIframe = true; }
        return env;
    }

    /** Fire-and-forget report to the local server (no-op on static hosting). */
    function report(payload) {
        try {
            const body = JSON.stringify(payload);
            if (navigator && typeof navigator.sendBeacon === 'function') {
                // text/plain keeps it a "simple" request (no CORS preflight,
                // which matters inside sandboxed iframes with opaque origins).
                if (navigator.sendBeacon('/api/log', new Blob([body], { type: 'text/plain' }))) return;
            }
            fetch('/api/log', { method: 'POST', body, keepalive: true }).catch(() => {});
        } catch (_) { /* best effort only */ }
    }

    /* ---------------- Utilities ---------------- */

    /** Escape a value for safe interpolation into HTML (fixes XSS). */
    const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

    /** Archive.org fields may arrive as strings, numbers or arrays. */
    function normalize(value, separator) {
        if (Array.isArray(value)) return value.filter(Boolean).map(String).join(separator);
        return value == null ? '' : String(value).trim();
    }

    /** Pull the first 4-digit year out of values like "1990", ["1990"] or "1990; 1991". */
    function extractYear(value) {
        const raw = Array.isArray(value) ? (value[0] ?? '') : value;
        const match = String(raw ?? '').match(/\d{4}/);
        return match ? match[0] : '';
    }

    /** Creators arrive as arrays or "; "-joined strings — show up to 2, then "+N". */
    function normalizeCreator(value) {
        let names = [];
        if (Array.isArray(value)) names = value;
        else if (typeof value === 'string') names = value.split(';');
        names = names.map((n) => String(n).trim()).filter(Boolean);
        if (!names.length) return null;
        return {
            text: names.slice(0, 2).join(', '),
            extra: Math.max(0, names.length - 2),
        };
    }

    function formatCount(n) {
        n = Number(n) || 0;
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(n);
    }

    /** Neutral inline-SVG placeholder for items with no thumbnail. */
    function placeholderDataUri(type) {
        const icon = ICONS[type] || ICONS.default;
        const svgStr =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300">' +
            '<rect width="480" height="300" fill="#232833"/>' +
            '<g transform="translate(216,126) scale(2)" stroke="#4b5468" stroke-width="2" fill="none" ' +
            'stroke-linecap="round" stroke-linejoin="round">' +
            icon.replace(/^<svg[^>]*>|<\/svg>$/g, '') +
            '</g></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    }

    const errText = (err) => String((err && (err.message || err.name)) || err).slice(0, 200);

    /* ---------------- Fetching ---------------- */

    /** fetch + JSON + per-route timeout, without aborting the global signal. */
    function fetchWithTimeout(url, signal, ms) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const e = new Error('timed out after ' + ms + ' ms');
                e.name = 'TimeoutError';
                reject(e);
            }, ms);
        });
        const request = fetch(url, { signal, redirect: 'follow' })
            .then((res) => {
                if (!res.ok) {
                    const e = new Error('HTTP ' + res.status);
                    e.status = res.status;
                    throw e;
                }
                return res.json();
            });
        request.catch(() => {}); // swallow late rejections after the race is settled
        return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * Try each transport in order until one returns a valid search payload.
     * Resolves with { data, transport, attempts }; throws with .attempts.
     */
    async function fetchSearchData(apiUrl, signal, onProgress) {
        const order = transportOrder();
        const attempts = [];
        let lastError = null;

        for (let n = 0; n < order.length; n++) {
            const idx = order[n];
            const transport = TRANSPORTS[idx];
            attempts.push({ route: transport.id });

            if (onProgress) {
                try { onProgress(transport, n + 1, order.length); } catch (_) { /* ignore */ }
            }

            try {
                const data = await fetchWithTimeout(transport.build(apiUrl), signal, TRANSPORT_TIMEOUT_MS);
                const resp = data && data.response;
                if (!resp || !Array.isArray(resp.docs) || typeof resp.numFound !== 'number') {
                    throw new Error('unexpected response shape');
                }
                attempts[attempts.length - 1].ok = true;
                rememberTransport(idx);
                return { data, transport, attempts };
            } catch (err) {
                if (err && err.name === 'AbortError' && signal && signal.aborted) {
                    throw err; // the search was superseded — stop trying routes
                }
                attempts[attempts.length - 1].error = errText(err);
                lastError = err;
            }
        }

        const err = new Error('all routes failed');
        err.attempts = attempts;
        err.lastError = lastError;
        throw err;
    }

    /* ---------------- API ---------------- */

    function buildApiUrl({ query, type, sort, page }) {
        const params = new URLSearchParams();

        let q = query;
        const mediatype = MEDIA_TYPES[type];
        if (mediatype) q += ` AND mediatype:(${mediatype})`;
        params.set('q', q);

        FIELDS.forEach((f) => params.append('fl[]', f));

        const sortClause = SORTS[sort];
        if (sortClause) params.append('sort[]', sortClause);

        params.set('rows', String(PAGE_SIZE));
        params.set('page', String(page));
        params.set('output', 'json');

        return API_URL + '?' + params.toString();
    }

    /* ---------------- URL <-> state sync ---------------- */

    function readStateFromURL() {
        const p = new URLSearchParams(location.search);
        state.query = (p.get('q') || '').trim().slice(0, 300);
        state.type = Object.prototype.hasOwnProperty.call(MEDIA_TYPES, p.get('type')) ? p.get('type') : 'all';
        state.sort = Object.prototype.hasOwnProperty.call(SORTS, p.get('sort')) ? p.get('sort') : 'relevance';
        state.page = Math.min(9999, Math.max(1, parseInt(p.get('page'), 10) || 1));
        els.input.value = state.query;
        reflectControls();
        updateClearButton();
    }

    function writeURL(replace = false) {
        const p = new URLSearchParams();
        if (state.query) p.set('q', state.query);
        if (state.type !== 'all') p.set('type', state.type);
        if (state.sort !== 'relevance') p.set('sort', state.sort);
        if (state.page > 1) p.set('page', String(state.page));

        const qs = p.toString();
        const url = location.pathname + (qs ? '?' + qs : '');
        try {
            if (replace) history.replaceState({ ...state }, '', url);
            else history.pushState({ ...state }, '', url);
        } catch (_) { /* private mode etc. — non-fatal */ }
    }

    /* ---------------- UI helpers ---------------- */

    function reflectControls() {
        els.typeGroup.querySelectorAll('.chip').forEach((chip) => {
            chip.setAttribute('aria-pressed', String(chip.dataset.type === state.type));
        });
        els.sortSelect.value = state.sort;
    }

    function updateClearButton() {
        els.clearBtn.hidden = els.input.value.length === 0;
    }

    function setLoading(isLoading) {
        els.submitBtn.disabled = isLoading;
        els.submitSpinner.hidden = !isLoading;
        els.submitLabel.textContent = isLoading ? 'Searching…' : 'Search';
        els.grid.setAttribute('aria-busy', String(isLoading));
    }

    function hideStates() {
        els.empty.hidden = true;
        els.error.hidden = true;
        els.pagination.hidden = true;
    }

    function clearGrid() {
        els.grid.replaceChildren();
    }

    function updateStatus(html) {
        els.status.innerHTML = html;
    }

    function resetToLanding() {
        state.query = '';
        state.page = 1;
        if (currentRequest) currentRequest.controller.abort();
        setLoading(false);
        hideStates();
        clearGrid();
        updateStatus('');
        els.landing.hidden = false;
        els.toolbar.hidden = true;
    }

    /* ---------------- Rendering ---------------- */

    function renderSkeletons() {
        clearGrid();
        const frag = document.createDocumentFragment();
        for (let i = 0; i < SKELETON_COUNT; i++) {
            const card = document.createElement('div');
            card.className = 'skeleton-card';
            card.setAttribute('aria-hidden', 'true');
            card.innerHTML =
                '<div class="sk sk-thumb"></div>' +
                '<div class="sk sk-line w80"></div>' +
                '<div class="sk sk-line w60"></div>' +
                '<div class="sk sk-line w40"></div>';
            frag.appendChild(card);
        }
        els.grid.appendChild(frag);
    }

    function buildCard(doc) {
        const identifier = String(doc.identifier || '');
        const title = normalize(doc.title, ' / ') || 'Untitled';
        const creator = normalizeCreator(doc.creator);
        const type = String(doc.mediatype || '').toLowerCase();
        const year = extractYear(doc.year);
        const downloads = Number(doc.downloads) || 0;

        const detailsUrl = DETAILS_URL + encodeURIComponent(identifier);
        const thumbUrl = THUMB_URL + encodeURIComponent(identifier);
        const typeIcon = ICONS[type] || ICONS.default;
        const typeLabel = TYPE_LABELS[type] || type || 'Item';

        const card = document.createElement('article');
        card.className = 'card';
        card.innerHTML =
            /* Thumbnail (decorative link — the title link carries the a11y weight) */
            '<a class="card-thumb" href="' + esc(detailsUrl) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' +
                '<img src="' + esc(thumbUrl) + '" alt="" loading="lazy" decoding="async" width="480" height="300">' +
                '<span class="type-badge">' + typeIcon + '<span>' + esc(typeLabel) + '</span></span>' +
            '</a>' +
            '<div class="card-body">' +
                '<h3 class="card-title">' +
                    '<a href="' + esc(detailsUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>' +
                '</h3>' +
                (creator
                    ? '<p class="card-creator">' + esc(creator.text) +
                      (creator.extra ? ' <span class="muted">+' + esc(creator.extra) + ' more</span>' : '') + '</p>'
                    : '<p class="card-creator">Unknown creator</p>') +
                ((year || downloads > 0)
                    ? '<p class="card-meta">' +
                      (year ? '<span>' + esc(year) + '</span>' : '') +
                      (year && downloads > 0 ? '<span class="dot">·</span>' : '') +
                      (downloads > 0 ? '<span>' + esc(formatCount(downloads)) + ' downloads</span>' : '') +
                      '</p>'
                    : '') +
            '</div>';

        // Graceful thumbnail fallback (event listener instead of inline onerror).
        const img = card.querySelector('img');
        img.addEventListener('error', () => {
            img.src = placeholderDataUri(type);
        }, { once: true });

        return card;
    }

    function renderResults(docs, numFound, elapsedSeconds) {
        clearGrid();
        hideStates();

        // Defensive: if we somehow requested a page past the end, hop back.
        const maxPage = Math.max(1, Math.ceil((numFound || 0) / PAGE_SIZE));
        if (state.page > maxPage) {
            state.page = maxPage;
            writeURL(true);
            void runSearch({ push: false });
            return;
        }

        if (!docs.length) {
            renderEmpty();
            return;
        }

        const frag = document.createDocumentFragment();
        docs.forEach((doc) => frag.appendChild(buildCard(doc)));
        els.grid.appendChild(frag);

        renderPagination(numFound);

        const seconds = elapsedSeconds.toFixed(2);
        updateStatus(
            'About <strong>' + Number(numFound).toLocaleString() + '</strong> results for ' +
            '<strong>\u201C' + esc(state.query) + '\u201D</strong> (' + seconds + ' s) — ' +
            'page ' + state.page + ' of ' + Number(maxPage).toLocaleString()
        );
    }

    function renderEmpty() {
        clearGrid();
        hideStates();
        els.emptyQuery.textContent = '\u201C' + state.query + '\u201D';
        els.empty.hidden = false;
        updateStatus('No results for \u201C' + esc(state.query) + '\u201D');
    }

    function renderError(err) {
        clearGrid();
        hideStates();

        let message;
        if (err && err.timedOut) {
            message = 'The search took too long and was cancelled. The Internet Archive may be busy — please try again.';
        } else if (err && Array.isArray(err.attempts)) {
            message = 'Couldn\u2019t reach the Internet Archive — all ' + err.attempts.length +
                ' routes failed (local server, archive.org, and mirror proxies). ' +
                'Check the technical details below, or try again in a moment.';
        } else if (err && err.status) {
            message = 'The Internet Archive returned an error (HTTP ' + err.status + '). ' +
                'It may be rate-limiting or temporarily busy — please try again in a moment.';
        } else {
            message = 'Couldn\u2019t reach the Internet Archive. Please check your connection and try again.';
        }
        els.errorMessage.textContent = message;

        // Machine-readable details, shown in a collapsed block and reported.
        const details = {
            error: errText(err),
            attempts: (err && err.attempts) || [],
            environment: envSnapshot(),
        };
        els.diagOutput.textContent = JSON.stringify(details, null, 2);
        els.diagDetails.hidden = false;
        report({ event: 'search-failed', details });

        els.error.hidden = false;
        updateStatus('Search failed');
    }

    function renderPagination(numFound) {
        const maxPage = Math.max(1, Math.ceil((numFound || 0) / PAGE_SIZE));
        if (maxPage <= 1) { els.pagination.hidden = true; return; }

        const entries = pageList(state.page, maxPage);
        const parts = [];

        parts.push('<button type="button" class="page-btn" data-page="' + (state.page - 1) + '"' +
            (state.page === 1 ? ' disabled' : '') + '>\u2190 Prev</button>');

        entries.forEach((entry) => {
            if (entry === '\u2026') {
                parts.push('<span class="page-ellipsis" aria-hidden="true">\u2026</span>');
            } else {
                const isCurrent = entry === state.page;
                parts.push(
                    '<button type="button" class="page-btn" data-page="' + entry + '"' +
                    (isCurrent ? ' aria-current="page"' : '') + '>' +
                    Number(entry).toLocaleString() + '</button>'
                );
            }
        });

        parts.push('<button type="button" class="page-btn" data-page="' + (state.page + 1) + '"' +
            (state.page === maxPage ? ' disabled' : '') + '>Next \u2192</button>');

        els.pagination.innerHTML = parts.join('');
        els.pagination.hidden = false;
    }

    /** 1 2 … c-1 c c+1 … n-1 n (no ellipses when the range is small). */
    function pageList(current, total) {
        if (total <= 7) {
            return Array.from({ length: total }, (_, i) => i + 1);
        }
        const wanted = new Set([1, 2, current - 1, current, current + 1, total - 1, total]);
        const sorted = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
        const out = [];
        let prev = 0;
        for (const p of sorted) {
            if (p - prev > 1) out.push('\u2026');
            out.push(p);
            prev = p;
        }
        return out;
    }

    /* ---------------- Search ---------------- */

    async function runSearch({ push = true } = {}) {
        const query = els.input.value.trim().slice(0, 300);
        state.query = query;

        if (!query) {
            resetToLanding();
            writeURL(true);
            return;
        }

        // Cancel any in-flight request so it can't overwrite these results.
        if (currentRequest) currentRequest.controller.abort();
        const controller = new AbortController();
        const token = ++requestToken;
        currentRequest = { controller, token, timedOut: false };
        const request = currentRequest;

        if (push) writeURL();
        els.landing.hidden = true;
        els.toolbar.hidden = false;

        setLoading(true);
        hideStates();
        renderSkeletons();
        updateStatus('Searching for \u201C' + esc(query) + '\u201D\u2026');

        const timer = setTimeout(() => {
            if (currentRequest === request) {
                request.timedOut = true;
                controller.abort();
            }
        }, REQUEST_TIMEOUT_MS);

        const startedAt = performance.now();

        try {
            const result = await fetchSearchData(
                buildApiUrl(state),
                controller.signal,
                (transport, n, total) => {
                    if (n > 1) {
                        updateStatus('Searching for \u201C' + esc(query) + '\u201D\u2026 ' +
                            '(route ' + n + '/' + total + ': ' + esc(transport.label) + ')');
                    }
                }
            );

            if (token !== requestToken) return; // a newer search superseded this one

            const elapsed = (performance.now() - startedAt) / 1000;
            const resp = result.data.response;
            renderResults(resp.docs, resp.numFound, elapsed);
            report({ event: 'search-ok', route: result.transport.id, ms: Math.round(elapsed * 1000), page: state.page });
        } catch (err) {
            if (token !== requestToken) return;            // superseded — ignore quietly
            if (err && err.name === 'AbortError') {
                if (request.timedOut) renderError({ timedOut: true });
                return;                                    // aborted by a newer search
            }
            renderError(err);
        } finally {
            clearTimeout(timer);
            if (token === requestToken) setLoading(false);
        }
    }

    /* ---------------- Background connectivity probe ---------------- */

    let probeStarted = false;
    function startConnectionProbe() {
        if (probeStarted) return;
        probeStarted = true;

        const probe = async () => {
            try {
                const out = { event: 'probe', environment: envSnapshot() };

                // 1. same-origin server check
                try {
                    await fetchWithTimeout('/api/ping', undefined, 6000);
                    out.ping = 'ok';
                } catch (err) {
                    out.ping = errText(err);
                }

                // 2. archive.org routes (stop at the first one that works)
                out.routes = [];
                const probeUrl = API_URL + '?q=test&rows=0&output=json';
                for (const idx of transportOrder()) {
                    const transport = TRANSPORTS[idx];
                    try {
                        const data = await fetchWithTimeout(transport.build(probeUrl), undefined, 7000);
                        if (!(data && data.response)) throw new Error('unexpected response shape');
                        out.routes.push({ route: transport.id, ok: true });
                        rememberTransport(idx);
                        break;
                    } catch (err) {
                        out.routes.push({ route: transport.id, error: errText(err) });
                    }
                }

                // 3. can cross-origin images load at all? (COEP / img-src check)
                if (typeof Image !== 'undefined') {
                    out.image = await new Promise((resolve) => {
                        let settled = false;
                        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
                        const imgTimer = setTimeout(() => finish('timeout'), 7000);
                        const img = new Image();
                        img.onload = () => { clearTimeout(imgTimer); finish('ok'); };
                        img.onerror = () => { clearTimeout(imgTimer); finish('error'); };
                        img.src = 'https://archive.org/favicon.ico';
                    });
                }

                report(out);
            } catch (_) { /* never disturb the page */ }
        };

        setTimeout(() => { probe().catch(() => {}); }, PROBE_DELAY_MS);
    }

    /* ---------------- Events ---------------- */

    els.form.addEventListener('submit', (e) => {
        e.preventDefault();
        state.page = 1;
        void runSearch();
    });

    // Media-type chips (event delegation).
    els.typeGroup.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip || chip.dataset.type === state.type) return;
        state.type = chip.dataset.type;
        state.page = 1;
        reflectControls();
        void runSearch();
    });

    els.sortSelect.addEventListener('change', () => {
        state.sort = els.sortSelect.value;
        state.page = 1;
        void runSearch();
    });

    // Pagination (event delegation).
    els.pagination.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn || btn.disabled) return;
        const page = parseInt(btn.dataset.page, 10);
        if (!Number.isFinite(page) || page === state.page) return;
        state.page = Math.max(1, page);
        void runSearch();
        els.section.scrollIntoView({
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'start',
        });
    });

    // Example chips on the landing page / empty state.
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-query]');
        if (!chip) return;
        els.input.value = chip.dataset.query;
        state.page = 1;
        updateClearButton();
        void runSearch();
    });

    els.retryBtn.addEventListener('click', () => {
        void runSearch({ push: false });
    });

    els.clearBtn.addEventListener('click', () => {
        els.input.value = '';
        updateClearButton();
        els.input.focus();
    });

    els.input.addEventListener('input', updateClearButton);

    // Press "/" anywhere to focus the search box.
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
        e.preventDefault();
        els.input.focus();
        els.input.select();
    });

    // Back/forward navigation.
    window.addEventListener('popstate', (e) => {
        readStateFromURL();
        if (e.state && typeof e.state === 'object' && 'query' in e.state) {
            state.query = String(e.state.query || '');
            state.type = MEDIA_TYPES[e.state.type] !== undefined ? e.state.type : 'all';
            state.sort = SORTS[e.state.sort] !== undefined ? e.state.sort : 'relevance';
            state.page = Math.max(1, parseInt(e.state.page, 10) || 1);
            els.input.value = state.query;
            reflectControls();
            updateClearButton();
        }
        if (state.query) void runSearch({ push: false });
        else resetToLanding();
    });

    /* ---------------- Theme ---------------- */

    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem('as-theme', theme); } catch (_) { /* ignore */ }
        els.themeToggle.setAttribute(
            'aria-label',
            theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
        );
    }

    els.themeToggle.addEventListener('click', () => {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    // Follow OS theme changes while the user hasn't picked an explicit theme.
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', (e) => {
        let saved = null;
        try { saved = localStorage.getItem('as-theme'); } catch (_) { /* ignore */ }
        if (!saved) applyTheme(e.matches ? 'light' : 'dark');
    });

    /* ---------------- Boot ---------------- */

    applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    readStateFromURL();
    startConnectionProbe();

    // Deep link: ?q=… restores the previous search.
    if (state.query) {
        els.landing.hidden = true;
        els.toolbar.hidden = false;
        void runSearch({ push: false });
    }
})();
