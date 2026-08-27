#!/usr/bin/env node
/**
 * Archive Search — zero-dependency server.
 *
 *   node server.js                # serves on http://0.0.0.0:8080
 *   PORT=3000 node server.js
 *
 * Endpoints:
 *   GET  /*            static files from this directory
 *   GET  /api/ping     health check (used by the page's diagnostics)
 *   GET  /api/search   same-origin relay to archive.org's advancedsearch API —
 *                      lets the page search without any CORS at all when the
 *                      server can reach the internet
 *   POST /api/log      receives anonymous connectivity diagnostics from the
 *                      page (appended to diagnostics.log)
 *
 * The page works fine without this server (any static host will do) — it then
 * talks to archive.org directly, with public mirrors as fallback. See app.js.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const UPSTREAM = 'https://archive.org/advancedsearch.php';
const UPSTREAM_TIMEOUT_MS = 15000;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
};

/* Every API response is CORS-open. The page is normally same-origin, but if it
   is embedded in a sandboxed iframe (opaque origin) its fetches are treated as
   cross-origin — these headers keep the API usable even then. */
function corsHeaders(extra) {
    return Object.assign({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }, extra || {});
}

function send(res, status, body, type, extraHeaders) {
    res.writeHead(status, corsHeaders(Object.assign({
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
    }, extraHeaders || {})));
    res.end(body);
}

function sendJSON(res, status, obj) {
    send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function safeDecode(p) {
    try { return decodeURIComponent(p); } catch (_) { return p; }
}

const server = http.createServer((req, res) => {
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch (_) {
        return send(res, 400, 'Bad request');
    }
    const pathname = safeDecode(url.pathname);

    /* ---------- health check ---------- */
    if (pathname === '/api/ping') {
        return sendJSON(res, 200, { ok: true, server: 'archive-search', time: new Date().toISOString() });
    }

    /* ---------- CORS preflight (for sandboxed-iframe POSTs) ---------- */
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
    }

    /* ---------- search relay ---------- */
    if (pathname === '/api/search') {
        if (req.method !== 'GET') return sendJSON(res, 405, { error: 'GET only' });

        const target = UPSTREAM + (url.search || '');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

        fetch(target, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'archive-search/1.0 (https://github.com/samuelpeplinski9-web/archive-search)',
            },
        }).then(async (up) => {
            const body = await up.text();
            clearTimeout(timer);
            let valid = false;
            try { JSON.parse(body); valid = true; } catch (_) { valid = false; }
            if (!valid) {
                return sendJSON(res, 502, { error: 'upstream returned non-JSON', upstreamStatus: up.status });
            }
            send(res, up.ok ? 200 : 502, body, 'application/json; charset=utf-8');
        }).catch((err) => {
            clearTimeout(timer);
            const detail = (err && err.cause && err.cause.code) || (err && err.message) || String(err);
            sendJSON(res, 502, { error: 'upstream unreachable', detail: String(detail) });
        });
        return;
    }

    /* ---------- diagnostics log ---------- */
    if (pathname === '/api/log') {
        if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
        let body = '';
        let tooBig = false;
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 65536) { tooBig = true; req.destroy(); }
        });
        req.on('end', () => {
            if (!tooBig && body) {
                let entry = body.trim();
                try { entry = JSON.stringify(JSON.parse(body)); } catch (_) { /* keep raw */ }
                const line = new Date().toISOString() + ' ' + entry + '\n';
                fs.appendFile(path.join(ROOT, 'diagnostics.log'), line, () => {});
                console.log('[diagnostics]', line.trim());
            }
            sendJSON(res, 200, { ok: true });
        });
        return;
    }

    /* ---------- static files ---------- */
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.normalize(path.join(ROOT, rel));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        return send(res, 403, 'Forbidden');
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) return send(res, 404, 'Not found');
        const ext = path.extname(filePath).toLowerCase();
        fs.readFile(filePath, (readErr, buf) => {
            if (readErr) return send(res, 500, 'Read error');
            send(res, 200, buf, MIME[ext] || 'application/octet-stream');
        });
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Archive Search server running on http://0.0.0.0:' + PORT);
    console.log('  static files : ' + ROOT);
    console.log('  search relay : /api/search -> ' + UPSTREAM);
    console.log('  diagnostics  : POST /api/log -> diagnostics.log');
});
