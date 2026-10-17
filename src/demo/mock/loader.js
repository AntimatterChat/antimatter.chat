// The demo's first page (/demo/): it installs the service worker that carries the app's requests to the mock server,
// then opens the app. Its links from the site pass the site's language (?lang=fr), which becomes the app's language.
(function () {
    'use strict';
    var script = document.getElementById('demo-loader');
    var base = script.dataset.base;
    var params = new URLSearchParams(location.search);
    var lang = params.get('lang');
    var path = params.get('path') || '';

    try {
        if (lang) {
            sessionStorage.setItem('demoLang', lang);
        }
        if (params.get('demo-debug') === '1') {
            sessionStorage.setItem('demoDebug', '1'); // The mock server then logs what it answers by default.
        }
    } catch (e) {
        // Storage refused: the app stays in the browser's language.
    }

    function strings() {
        return fetch(base + 'mock/i18n.json?v=' + script.dataset.version).then(function (r) {
            return r.json();
        });
    }

    function pick(all) {
        var wanted = (lang || navigator.language || 'en').toLowerCase();
        return all[wanted] || all[wanted.split('-')[0]] || all.en;
    }

    function translate(t) {
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            el.textContent = t[el.dataset.i18n] || el.textContent;
        });
        var code = (lang || '').split('-')[0];
        if (['ar', 'fa', 'he', 'ur'].indexOf(code) >= 0) {
            document.documentElement.dir = 'rtl';
        }
        if (lang) {
            document.documentElement.lang = lang;
        }
    }

    var ready = strings().then(function (all) {
        var t = pick(all);
        translate(t);
        return t;
    }).catch(function () {
        return null;
    });

    function fail(t) {
        var status = document.querySelector('.demo-loader-status');
        status.classList.add('error');
        status.textContent = (t && t.no_sw) || 'This demo needs service workers, which this browser or window has turned off.';
    }

    if (!('serviceWorker' in navigator)) {
        ready.then(fail);
        return;
    }

    // Opens the app once the worker controls this page: its routes are answered by the worker from then on.
    function open() {
        var target = base + (path && !/^(index\.html)?$/.test(path) ? path.replace(/^\/+/, '') : 'lumen/channels/town-square');
        location.replace(target);
    }

    if (navigator.serviceWorker.controller) {
        open();
        return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', open);
    navigator.serviceWorker.register(base + 'sw.js', {scope: base}).catch(function () {
        ready.then(fail);
    });
}());
