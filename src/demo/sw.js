// The demo's service worker. It answers nothing itself: it hands every API request of the app (/demo/api/...,
// /demo/plugins/<id>/...) to the page that made it, where the mock server (mock/server.js) keeps the demo's data in
// memory. The data therefore lives as long as the page, and a reload starts again from the fixtures, even when the
// browser stops this worker between requests.
//
// Navigations anywhere under /demo/ (the app's own routes, like /demo/lumen/channels/town-square) get the app's page,
// app.html; the real files under /demo/ (static/, mock/, fixtures/) come from the site as they are.

/* eslint-env serviceworker */
'use strict';

const SCOPE = new URL(self.registration.scope).pathname; // "/demo/"
const FILES = /^(static|mock|fixtures)\/|^(sw\.js|app\.html|build\.json)$/;
const API = /^(api\/v4\/|plugins\/[^/]+\/)/;
const TIMEOUT_MS = 20000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) {
        return;
    }
    const rest = url.pathname.slice(SCOPE.length);
    if (e.request.mode === 'navigate') {
        if (rest === '' || rest === 'index.html' || FILES.test(rest)) {
            return; // The loader (index.html) boots the app itself, and real files are served as they are.
        }
        e.respondWith(appPage(url));
        return;
    }
    if (API.test(rest)) {
        e.respondWith(forward(e, url));
        return;
    }
    // The system emoji, which the app loads from <site>/static/emoji/, are Fusion's own.
    if (rest.indexOf('static/emoji/') === 0) {
        e.respondWith(fetch(SCOPE + 'static/fusion/emoji/' + rest.slice('static/emoji/'.length)));
    }
});

// appPage serves app.html for one of the app's routes, fresh from the site so a new demo shows at once.
async function appPage(url) {
    try {
        const res = await fetch(SCOPE + 'app.html', {cache: 'no-cache'});
        if (res.ok) {
            return new Response(res.body, {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}});
        }
    } catch {
        // Offline: fall through to the loader, which says so.
    }
    return Response.redirect(SCOPE + '?path=' + encodeURIComponent(url.pathname.slice(SCOPE.length) + url.search), 302);
}

// pickClient finds the page that answers a request: the one that made it, or (for requests made by a worker) any
// demo page.
async function pickClient(clientId) {
    if (clientId) {
        const c = await self.clients.get(clientId);
        if (c && c.type === 'window') {
            return c;
        }
    }
    const all = await self.clients.matchAll({type: 'window'});
    return all.find((c) => new URL(c.url).pathname.startsWith(SCOPE)) || null;
}

async function forward(e, url) {
    const req = e.request;
    const client = await pickClient(e.clientId || e.resultingClientId);
    if (!client) {
        return json(503, {id: 'demo.no_page', message: 'The demo page is not running.', status_code: 503});
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
    const message = {
        type: 'demo-request',
        method: req.method,
        url: url.pathname.slice(SCOPE.length - 1) + url.search, // "/api/v4/users/me?x=1"
        headers: Object.fromEntries(req.headers.entries()),
        body,
    };
    const reply = await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve({status: 504, json: {id: 'demo.timeout', message: 'The demo did not answer.', status_code: 504}}), TIMEOUT_MS);
        channel.port1.onmessage = (ev) => {
            clearTimeout(timer);
            resolve(ev.data);
        };
        client.postMessage(message, body ? [channel.port2, body] : [channel.port2]);
    });
    return toResponse(reply);
}

// toResponse turns the page's answer into a Response: JSON, text, a Blob, or a file of the site to serve instead
// (fixture images such as avatars and file previews).
async function toResponse(reply) {
    const headers = new Headers(reply.headers || {});
    if (reply.file) {
        try {
            const res = await fetch(reply.file);
            if (res.ok) {
                const h = new Headers(res.headers);
                for (const [k, v] of headers) {
                    h.set(k, v);
                }
                h.set('Cache-Control', 'no-cache');
                return new Response(res.body, {status: reply.status || 200, headers: h});
            }
        } catch {
            // The fixture file is missing: answer 404 below.
        }
        return json(404, {id: 'demo.not_found', message: 'Not in the demo.', status_code: 404});
    }
    if (reply.blob) {
        if (!headers.has('Content-Type') && reply.blob.type) {
            headers.set('Content-Type', reply.blob.type);
        }
        return new Response(reply.blob, {status: reply.status || 200, headers});
    }
    if ('json' in reply) {
        headers.set('Content-Type', 'application/json');
        return new Response(reply.status === 204 ? null : JSON.stringify(reply.json), {status: reply.status || 200, headers});
    }
    return new Response(reply.status === 204 ? null : reply.text || '', {status: reply.status || 200, headers});
}

function json(status, value) {
    return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
}
