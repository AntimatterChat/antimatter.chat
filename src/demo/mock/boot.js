// Starts the demo in app.html, before the app: checks the service worker carries the app's requests (or goes through
// the loader, /demo/, which installs it), loads the mock server's fixtures and the demo's banner, answers the
// worker's requests, then starts the app's own scripts.
(function () {
    'use strict';
    var script = document.getElementById('demo-boot');
    var base = script.dataset.base;
    var version = script.dataset.version;
    var appScripts = JSON.parse(script.dataset.app || '[]');

    // The app's assets live under the demo's path (what the server sets up for a site URL with a path).
    window.publicPath = base + 'static/';

    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        // Not installed yet, or bypassed (a hard reload): the loader installs it and comes back here.
        location.replace(base + '?path=' + encodeURIComponent(location.pathname.slice(base.length) + location.search));
        return;
    }

    // Site languages (the ?lang= of the site's links) and the app's matching locales.
    var LOCALES = {'pt-br': 'pt-BR', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', nb: 'nb-NO'};
    var lang = '';
    try {
        lang = sessionStorage.getItem('demoLang') || '';
        // Nothing done in the demo is kept: what the app keeps in this browser (drafts, recent emoji...) goes too.
        Object.keys(localStorage).forEach(function (k) {
            if (k.indexOf('demo') !== 0) {
                localStorage.removeItem(k);
            }
        });
    } catch (e) {
        // Storage refused.
    }
    var locale = lang ? (LOCALES[lang] || lang) : '';

    navigator.serviceWorker.addEventListener('message', function (ev) {
        var msg = ev.data;
        if (!msg || msg.type !== 'demo-request' || !ev.ports[0]) {
            return;
        }
        window.DemoServer.handle(msg).then(function (res) {
            ev.ports[0].postMessage(res);
        });
    });
    navigator.serviceWorker.startMessages();

    function startApp() {
        var userId = window.DemoServer.userId();
        var path = base.replace(/\/$/, '') || '/';
        // The app tells signed-in visitors by these cookies; there is no session behind them.
        document.cookie = 'MMUSERID=' + userId + ';path=' + path + ';samesite=lax';
        document.cookie = 'MMCSRF=demo;path=' + path + ';samesite=lax';
        appScripts.forEach(function (src) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;
            document.head.appendChild(s);
        });
        if (window.DemoLife) {
            window.DemoLife.start(window.DemoServer.api);
        }
    }

    Promise.all([window.DemoServer.load({base: base, version: version, locale: locale, systemAdmin: false}), demoBanner()]).then(function (r) {
        Object.assign(r[0].config, r[1]);
        startApp();
    }, function (e) {
        console.error('[demo] the fixtures did not load', e); // eslint-disable-line no-console
        document.body.textContent = 'The demo could not start. Reload the page to try again.';
    });

    // Calls: the demo has no media server, so joining a call is refused (the app says calls are off here) before the
    // browser asks for the microphone.
    function guardCalls() {
        var calls = window.antimatterCalls;
        if (calls && typeof calls.join === 'function' && !calls.__demo) {
            calls.join = function () {
                return Promise.reject(new Error('Calls are not available in the demo.'));
            };
            calls.__demo = true;
        }
    }
    window.addEventListener('antimatter-calls:ready', guardCalls);
    var guardTimer = setInterval(guardCalls, 1000);
    setTimeout(function () {
        clearInterval(guardTimer);
    }, 60000);

    // The banner is the app's own announcement bar (the one an administrator can set), so the app makes room for it
    // above its top bar, on computers and phones. Its two links are taken over here: "Start over" reloads the demo
    // (which starts again from the fixtures), "Back to the website" leaves it.
    var START_OVER = location.origin + base + '?start-over=1';
    var BACK = location.origin + '/' + (lang && lang !== 'en' ? lang + '/' : '');
    function bannerConfig(t) {
        var text = t.banner + ' [' + t.start_over + '](' + START_OVER + ') · [' + t.back + '](' + BACK + ')';
        return {EnableBanner: 'true', BannerText: text, BannerColor: '#6d28d9', BannerTextColor: '#ffffff',
            AllowBannerDismissal: 'true'};
    }
    document.addEventListener('click', function (e) {
        var link = e.target && e.target.closest && e.target.closest('.admin-announcement a[href]');
        if (!link) {
            return;
        }
        var href = link.getAttribute('href');
        if (href === START_OVER || href === BACK) {
            e.preventDefault();
            e.stopPropagation();
            location.assign(href === START_OVER ? base : href);
        }
    }, true);
    function demoBanner() {
        return fetch(base + 'mock/i18n.json?v=' + version).then(function (r) {
            return r.json();
        }).then(function (all) {
            var wanted = (lang || navigator.language || 'en').toLowerCase();
            return bannerConfig(all[wanted] || all[wanted.split('-')[0]] || all.en);
        }).catch(function () {
            return bannerConfig({banner: 'Demo with sample data. Nothing you do here is saved.', start_over: 'Start over',
                back: 'Back to the website'});
        });
    }
}());
