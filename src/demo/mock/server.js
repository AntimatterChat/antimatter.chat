// The demo's mock server. It runs in the page, before the app, and answers the requests the service worker (sw.js)
// hands it: the app's REST API (/api/v4/...) from the recorded fixtures (fixtures/*.json), with what the visitor
// does (posts, reactions, edits, preferences, uploads...) kept in memory until the page is reloaded. The apps' own
// routes are answered by mock/plugins.js, which registers them here.
//
// A request nobody answers gets a harmless empty answer ([] or {} for reads, OK for writes); with ?demo-debug=1
// in the address (remembered for the tab), each one is logged in the console and listed in window.__demoMisses.
(function () {
    'use strict';

    var S = {}; // The demo's data: see load().
    var routes = [];
    var misses = [];
    var debug = false;
    var base = '/demo/';
    var readyResolve;
    var ready = new Promise(function (resolve) {
        readyResolve = resolve;
    });
    var currentChannelId = '';
    var connectionId = newId();

    try {
        debug = /[?&]demo-debug=1/.test(location.search) || sessionStorage.getItem('demoDebug') === '1';
        if (debug) {
            sessionStorage.setItem('demoDebug', '1');
        }
    } catch (e) {
        // No storage: no debug.
    }

    // --- helpers -------------------------------------------------------------------------------------------------

    function newId() {
        var chars = 'abcdefghijkmnopqrstuwxyz13456789';
        var out = '';
        var bytes = new Uint8Array(26);
        crypto.getRandomValues(bytes);
        for (var i = 0; i < 26; i++) {
            out += chars[bytes[i] % chars.length];
        }
        return out;
    }

    function now() {
        return Date.now();
    }

    function clone(v) {
        return v === undefined ? v : JSON.parse(JSON.stringify(v));
    }

    function values(o) {
        return Object.keys(o || {}).map(function (k) {
            return o[k];
        });
    }

    function ok(extra) {
        return {json: Object.assign({status: 'OK'}, extra || {})};
    }

    function json(v, status) {
        return {json: v === undefined ? null : v, status: status || 200};
    }

    // Errors have the server's shape. Never 401: the app would sign out.
    function notFound(what) {
        return {status: 404, json: {id: 'demo.not_found', message: (what || 'This') + ' is not in the demo.', status_code: 404, detailed_error: ''}};
    }

    function forbidden(message) {
        return {status: 403, json: {id: 'demo.forbidden', message: message || 'This is not available in the demo.', status_code: 403,
            detailed_error: ''}};
    }

    function media(rel) {
        return {file: base + 'fixtures/media/' + rel};
    }

    function int(v, d) {
        var n = parseInt(v, 10);
        return isNaN(n) ? d : n;
    }

    function me() {
        return S.me;
    }

    function uid(id) {
        return id === 'me' ? S.me.id : id;
    }

    // --- loading the fixtures ------------------------------------------------------------------------------------

    // Every timestamp is moved by the time since the recording, so the conversations look as recent as they were then.
    var TIME_KEY = /(_at|At|_time|Time|^timestamp|_update|Update|^end|^start|^until|_date|Date)$/;
    var MIN_TS = 1.4e12;
    var MAX_TS = 2.3e12;

    function shiftTimes(v, delta, key) {
        if (typeof v === 'number') {
            return v > MIN_TS && v < MAX_TS && TIME_KEY.test(key || '') ? v + delta : v;
        }
        if (Array.isArray(v)) {
            for (var i = 0; i < v.length; i++) {
                v[i] = shiftTimes(v[i], delta, key);
            }
            return v;
        }
        if (v && typeof v === 'object') {
            Object.keys(v).forEach(function (k) {
                v[k] = shiftTimes(v[k], delta, k);
            });
        }
        return v;
    }

    function fetchFixture(name, version) {
        return fetch(base + 'fixtures/' + name + '?v=' + version).then(function (r) {
            if (!r.ok) {
                return name === 'plugins_webapp.json' ? '[]' : '{}';
            }
            return r.text();
        }).then(function (text) {
            var site = location.origin + base.replace(/\/$/, '');
            text = text.split('__SITE__').join(site).split('__MEDIA__').join(base + 'fixtures/media/');
            return JSON.parse(text);
        });
    }

    function load(opts) {
        base = opts.base;
        var names = ['core.json', 'users.json', 'posts.json', 'routes.json', 'apps.json', 'media.json', 'plugins_webapp.json'];
        return Promise.all(names.map(function (n) {
            return fetchFixture(n, opts.version);
        })).then(function (docs) {
            var core = docs[0];
            var delta = core.recorded_at ? now() - core.recorded_at : 0;
            docs.forEach(function (d, i) {
                if (i !== 3 && i !== 5) {
                    shiftTimes(d, delta, '');
                }
            });
            shiftTimes(docs[3], delta, '');
            build(core, docs[1], docs[2], docs[3], docs[4], docs[5], docs[6], opts);
            if (window.DemoPlugins) {
                window.DemoPlugins.init(api, S.apps);
            }
            readyResolve();
            return S;
        });
    }

    function build(core, users, posts, recorded, apps, mediaMap, plugins, opts) {
        S.core = core;
        // The demo is always signed in, as one person, with no setup, terms or second factor to go through.
        S.config = Object.assign({}, core.config || {}, {
            NoAccounts: 'false', EnableCustomTermsOfService: 'false', EnforceMultifactorAuthentication: 'false', EnableOnboardingFlow: 'false',
            EnableClientMetrics: 'false', EnableDiagnostics: 'false', DiagnosticsEnabled: 'false', WebsocketURL: '', WebsocketPort: '80',
            WebsocketSecurePort: '443', EnableUserTypingMessages: 'true', FeatureFlagContentFlagging: 'false', ContentFlaggingEnabled: 'false',
            AllowUserWebUISelection: 'false', EnableSignUpWithEmail: 'false', EnableUserCreation: 'false', EnableGuestAccounts: 'false',
            ExperimentalEnableAuthenticationTransfer: 'false', EnablePreviewModeBanner: 'false',
        });
        S.license = core.license || {};
        // As the server tells it (X-Version-Id, the websocket's hello): <version>.<build>.<config hash>.<licensed>. The app
        // checks features against the version's first three numbers.
        S.serverVersion = [S.config.Version || '12.0.0', S.config.BuildNumber || '0', 'demo', 'true'].join('.');
        S.me = core.me;
        if (opts.locale) {
            S.me.locale = opts.locale;
        }
        if (!opts.systemAdmin) {
            // The System Console isn't part of the demo: maya stays a team admin, not a system admin.
            S.me.roles = (S.me.roles || '').split(' ').filter(function (r) {
                return r !== 'system_admin';
            }).join(' ');
        }
        S.users = {};
        (users.users || []).forEach(function (u) {
            S.users[u.id] = u;
        });
        S.users[S.me.id] = S.me;
        S.bots = users.bots || [];
        S.statuses = {};
        (users.statuses || []).forEach(function (st) {
            S.statuses[st.user_id] = st;
        });
        S.statuses[S.me.id] = Object.assign(S.statuses[S.me.id] || {}, {user_id: S.me.id, status: 'online', manual: false, last_activity_at: now()});
        S.teams = {};
        (core.teams || []).forEach(function (t) {
            S.teams[t.id] = t;
        });
        S.myTeamMembers = {};
        (core.team_members || []).forEach(function (m) {
            S.myTeamMembers[m.team_id] = m;
        });
        S.teamMemberLists = core.team_member_lists || {};
        S.teamStats = core.team_stats || {};
        S.channels = {};
        S.myMembers = {};
        (posts.channels || []).forEach(function (c) {
            S.channels[c.id] = c;
        });
        Object.keys(core.channels || {}).forEach(function (tid) {
            (core.channels[tid] || []).forEach(function (c) {
                S.channels[c.id] = c;
            });
            (core.channel_members[tid] || []).forEach(function (m) {
                S.myMembers[m.channel_id] = m;
            });
        });
        S.publicChannels = core.public_channels || {};
        S.channelMembers = posts.members || {};
        S.channelStats = posts.stats || {};
        S.categories = core.categories || {};
        S.preferences = core.preferences || [];
        S.roles = {};
        (core.roles || []).concat(values(core.group_team_roles || {})).forEach(function (r) {
            S.roles[r.name] = r;
        });
        S.emoji = {};
        (core.emoji || []).forEach(function (e) {
            S.emoji[e.id] = e;
        });
        S.posts = posts.posts || {};
        S.files = {};
        values(S.posts).forEach(function (p) {
            ((p.metadata || {}).files || []).forEach(function (f) {
                S.files[f.id] = f;
            });
        });
        S.blobs = {};
        S.threads = {};
        Object.keys(core.threads || {}).forEach(function (tid) {
            ((core.threads[tid] || {}).threads || []).forEach(function (t) {
                S.threads[t.id] = Object.assign({}, t, {team_id: tid});
                delete S.threads[t.id].post;
            });
        });
        S.drafts = core.drafts || {};
        S.scheduled = core.scheduled_posts || {};
        S.groups = core.custom_groups || [];
        S.groupTeamRoles = core.group_team_roles || {};
        S.onTop = core.on_top || {};
        S.commands = core.commands || {};
        S.pluginStatuses = core.plugin_statuses || [];
        S.recorded = recorded || {};
        S.media = mediaMap || {};
        S.apps = apps || {};
        S.plugins = plugins || [];
        S.recentMentions = core.recent_mentions;
        S.flagged = core.flagged;
        indexPosts();
    }

    function indexPosts() {
        S.byChannel = {};
        S.replies = {};
        values(S.posts).forEach(function (p) {
            (S.byChannel[p.channel_id] = S.byChannel[p.channel_id] || []).push(p.id);
            if (p.root_id) {
                (S.replies[p.root_id] = S.replies[p.root_id] || []).push(p.id);
            }
        });
        Object.keys(S.byChannel).forEach(sortChannel);
        // What the server works out for collapsed threads: each root's reply count, last reply and participants.
        Object.keys(S.replies).forEach(function (rootId) {
            var root = S.posts[rootId];
            if (!root) {
                return;
            }
            var replies = S.replies[rootId].map(function (id) {
                return S.posts[id];
            }).filter(visible).sort(function (a, b) {
                return a.create_at - b.create_at;
            });
            root.reply_count = replies.length;
            root.last_reply_at = replies.length ? replies[replies.length - 1].create_at : 0;
            var who = [];
            replies.forEach(function (r) {
                if (who.indexOf(r.user_id) < 0) {
                    who.push(r.user_id);
                }
            });
            root.participants = who.map(function (id) {
                return S.users[id];
            }).filter(Boolean);
            replies.forEach(function (r) {
                r.reply_count = replies.length;
            });
        });
    }

    function sortChannel(cid) {
        (S.byChannel[cid] || []).sort(function (a, b) {
            return S.posts[b].create_at - S.posts[a].create_at;
        });
    }

    // --- routing -------------------------------------------------------------------------------------------------

    // route(method, '/api/v4/users/:uid/image', fn): fn(req, params) returns an answer: {json, status} or {file} or
    // {blob} or {text}, or a promise of one.
    function route(method, pattern, fn) {
        var names = [];
        var re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([a-z_]+)/gi, function (_, n) {
            names.push(n);
            return '/([^/]+)';
        }).replace(/\/\*$/, '/(.*)') + '$');
        routes.push({method: method, re: re, names: names, fn: fn, pattern: pattern});
    }

    function parseBody(msg) {
        var type = (msg.headers['content-type'] || '').toLowerCase();
        if (!msg.body) {
            return Promise.resolve(null);
        }
        if (type.indexOf('multipart/form-data') >= 0) {
            return new Response(msg.body, {headers: {'Content-Type': msg.headers['content-type']}}).formData();
        }
        var text = new TextDecoder().decode(msg.body);
        if (type.indexOf('json') >= 0 || /^\s*[[{"]/.test(text)) {
            try {
                return Promise.resolve(JSON.parse(text));
            } catch (e) {
                return Promise.resolve(text);
            }
        }
        if (type.indexOf('octet-stream') >= 0 || type.indexOf('image/') === 0) {
            return Promise.resolve(new Blob([msg.body], {type: type}));
        }
        return Promise.resolve(text);
    }

    function handle(msg) {
        return ready.then(function () {
            return parseBody(msg);
        }).then(function (body) {
            var u = new URL(msg.url, location.origin);
            var req = {method: msg.method, path: u.pathname, query: u.searchParams, body: body, headers: msg.headers, url: msg.url};
            return dispatch(req);
        }).then(function (res) {
            return normalize(res);
        }).catch(function (e) {
            console.error('[demo] error answering', msg.method, msg.url, e); // eslint-disable-line no-console
            return {status: 500, json: {id: 'demo.error', message: String(e && e.message || e), status_code: 500}};
        });
    }

    // normalize completes an answer: the app reads the server's version from X-Version-Id on its JSON answers (it
    // waits for it before loading the roles).
    function normalize(res) {
        if (!res) {
            res = {json: {}};
        } else if (!(res.json !== undefined || res.file || res.blob || res.text !== undefined)) {
            res = {json: res};
        }
        if (res.json !== undefined) {
            res.headers = Object.assign({'X-Version-Id': S.serverVersion || 'demo'}, res.headers || {});
        }
        return res;
    }

    function dispatch(req) {
        var method = req.method === 'HEAD' ? 'GET' : req.method;
        for (var i = 0; i < routes.length; i++) {
            var r = routes[i];
            if (r.method !== method && r.method !== '*') {
                continue;
            }
            var m = r.re.exec(req.path);
            if (!m) {
                continue;
            }
            var params = {};
            r.names.forEach(function (n, j) {
                params[n] = decodeURIComponent(m[j + 1]);
            });
            if (m.length > r.names.length + 1) {
                params.rest = m[r.names.length + 1];
            }
            var res = r.fn(req, params);
            if (res !== undefined) {
                return res;
            }
        }
        return replay(req) || mediaFor(req) || fallback(req);
    }

    // replay answers from routes.json: by method and full path with query, then without the query.
    function replay(req) {
        var keyFull = req.method + ' ' + req.path + (req.query.toString() ? '?' + req.query.toString() : '');
        var key = req.method + ' ' + req.path;
        var v = S.recorded[keyFull];
        if (v === undefined) {
            v = S.recorded[key];
        }
        if (v === undefined) {
            return null;
        }
        if (v && v.__status) {
            return {status: v.__status, json: clone(v.body)};
        }
        return json(clone(v));
    }

    function mediaFor(req) {
        if (req.method !== 'GET') {
            return null;
        }
        var q = req.query.toString();
        var rel = S.media[req.path + (q ? '?' + q : '')] || S.media[req.path];
        if (!rel) {
            // The same image with other options (?width=, ?_=timestamp): the first recorded one.
            var prefix = req.path + '?';
            var key = Object.keys(S.media).find(function (k) {
                return k.indexOf(prefix) === 0;
            });
            rel = key && S.media[key];
        }
        return rel ? media(rel) : null;
    }

    function fallback(req) {
        if (debug) {
            console.info('[demo] unanswered', req.method, req.url, req.body); // eslint-disable-line no-console
        }
        misses.push(req.method + ' ' + req.url);
        if (req.method === 'GET') {
            var last = req.path.split('/').pop();
            if (/\/(image|thumbnail|preview|icon)$/.test(req.path)) {
                return notFound('This image');
            }
            return json(/s$|^(ids|search|autocomplete|suggestions|recent|history)$/.test(last) ? [] : {});
        }
        if (req.method === 'DELETE') {
            return ok();
        }
        return json(req.body && typeof req.body === 'object' && !(req.body instanceof FormData) ? req.body : {status: 'OK'});
    }

    // --- events (the fake websocket) -------------------------------------------------------------------------------

    function emit(event, data, broadcast) {
        if (!window.DemoSocket) {
            return;
        }
        window.DemoSocket.broadcast({
            event: event,
            data: data || {},
            broadcast: Object.assign({omit_users: null, user_id: '', channel_id: '', team_id: ''}, broadcast || {}),
        });
    }

    // --- users -------------------------------------------------------------------------------------------------------

    function user(id) {
        return S.users[uid(id)];
    }

    function sanitizeUser(u) {
        return u;
    }

    function teamMemberIds(tid) {
        return (S.teamMemberLists[tid] || []).filter(function (m) {
            return !m.delete_at;
        }).map(function (m) {
            return m.user_id;
        });
    }

    function channelMemberIds(cid) {
        var c = S.channels[cid];
        if (c && (c.type === 'D')) {
            return c.name.split('__');
        }
        return (S.channelMembers[cid] || []).map(function (m) {
            return m.user_id;
        });
    }

    function listUsers(q) {
        var list = values(S.users).filter(function (u) {
            return !u.delete_at || q.get('inactive') === 'true' || q.get('active') === 'false';
        });
        if (q.get('in_team')) {
            var inTeam = teamMemberIds(q.get('in_team'));
            list = list.filter(function (u) {
                return inTeam.indexOf(u.id) >= 0;
            });
        }
        if (q.get('not_in_team')) {
            var notTeam = teamMemberIds(q.get('not_in_team'));
            list = list.filter(function (u) {
                return notTeam.indexOf(u.id) < 0;
            });
        }
        if (q.get('in_channel')) {
            var inCh = channelMemberIds(q.get('in_channel'));
            list = list.filter(function (u) {
                return inCh.indexOf(u.id) >= 0;
            });
        }
        if (q.get('not_in_channel')) {
            var notCh = channelMemberIds(q.get('not_in_channel'));
            list = list.filter(function (u) {
                return notCh.indexOf(u.id) < 0;
            });
        }
        if (q.get('role')) {
            list = list.filter(function (u) {
                return (u.roles || '').split(' ').indexOf(q.get('role')) >= 0;
            });
        }
        if (q.get('active') === 'true') {
            list = list.filter(function (u) {
                return !u.delete_at;
            });
        }
        if (q.get('sort') === 'last_activity_at') {
            list.sort(function (a, b) {
                return ((S.statuses[b.id] || {}).last_activity_at || 0) - ((S.statuses[a.id] || {}).last_activity_at || 0);
            });
        } else if (q.get('sort') === 'create_at') {
            list.sort(function (a, b) {
                return b.create_at - a.create_at;
            });
        } else {
            list.sort(function (a, b) {
                return a.username.localeCompare(b.username);
            });
        }
        var page = int(q.get('page'), 0);
        var per = int(q.get('per_page'), 60);
        return list.slice(page * per, page * per + per);
    }

    function matchesTerm(u, term) {
        term = (term || '').toLowerCase().replace(/^@/, '');
        if (!term) {
            return true;
        }
        return [u.username, u.first_name, u.last_name, u.nickname, (u.first_name || '') + ' ' + (u.last_name || '')].some(function (s) {
            return (s || '').toLowerCase().indexOf(term) === 0;
        }) || (u.username || '').toLowerCase().indexOf(term) >= 0;
    }

    route('POST', '/api/v4/users/login', function () {
        return json(S.me);
    });
    route('POST', '/api/v4/users/logout', function () {
        // Signing out of the demo goes back to the site.
        setTimeout(function () {
            location.href = '/';
        }, 50);
        return ok();
    });
    route('GET', '/api/v4/users/me', function () {
        return json(S.me);
    });
    route('GET', '/api/v4/users', function (req) {
        return json(listUsers(req.query));
    });
    route('POST', '/api/v4/users/ids', function (req) {
        return json((req.body || []).map(user).filter(Boolean));
    });
    route('POST', '/api/v4/users/usernames', function (req) {
        var names = req.body || [];
        return json(values(S.users).filter(function (u) {
            return names.indexOf(u.username) >= 0;
        }));
    });
    route('POST', '/api/v4/users/group_channels', function (req) {
        var out = {};
        (req.body || []).forEach(function (cid) {
            out[cid] = channelMemberIds(cid).filter(function (id) {
                return id !== S.me.id;
            }).map(user).filter(Boolean);
        });
        return json(out);
    });
    route('GET', '/api/v4/users/autocomplete', function (req) {
        var q = req.query;
        var term = q.get('name') || '';
        var limit = int(q.get('limit'), 25);
        var pool = values(S.users).filter(function (u) {
            return !u.delete_at && matchesTerm(u, term);
        });
        if (q.get('in_team')) {
            var team = teamMemberIds(q.get('in_team'));
            pool = pool.filter(function (u) {
                return team.indexOf(u.id) >= 0 || u.is_bot;
            });
        }
        if (q.get('in_channel')) {
            var inCh = channelMemberIds(q.get('in_channel'));
            return json({
                users: pool.filter(function (u) {
                    return inCh.indexOf(u.id) >= 0;
                }).slice(0, limit),
                out_of_channel: pool.filter(function (u) {
                    return inCh.indexOf(u.id) < 0;
                }).slice(0, limit),
            });
        }
        return json({users: pool.slice(0, limit)});
    });
    route('POST', '/api/v4/users/search', function (req) {
        var b = req.body || {};
        var pool = values(S.users).filter(function (u) {
            return (b.allow_inactive || !u.delete_at) && matchesTerm(u, b.term);
        });
        if (b.team_id) {
            var team = teamMemberIds(b.team_id);
            pool = pool.filter(function (u) {
                return team.indexOf(u.id) >= 0;
            });
        }
        if (b.in_channel_id) {
            var inCh = channelMemberIds(b.in_channel_id);
            pool = pool.filter(function (u) {
                return inCh.indexOf(u.id) >= 0;
            });
        }
        if (b.not_in_channel_id) {
            var notCh = channelMemberIds(b.not_in_channel_id);
            pool = pool.filter(function (u) {
                return notCh.indexOf(u.id) < 0;
            });
        }
        return json(pool.slice(0, b.limit || 100));
    });
    route('GET', '/api/v4/users/stats', function () {
        return json({total_users_count: values(S.users).filter(function (u) {
            return !u.is_bot && !u.delete_at;
        }).length});
    });
    route('GET', '/api/v4/users/username/:name', function (req, p) {
        var u = values(S.users).find(function (x) {
            return x.username === p.name;
        });
        return u ? json(u) : notFound('This person');
    });
    route('GET', '/api/v4/users/email/:email', function (req, p) {
        var u = values(S.users).find(function (x) {
            return x.email === p.email;
        });
        return u ? json(u) : notFound('This person');
    });
    route('GET', '/api/v4/users/:uid/image', function (req, p) {
        var rel = S.media['/api/v4/users/' + uid(p.uid) + '/image'];
        if (S.blobs['avatar:' + uid(p.uid)]) {
            return {blob: S.blobs['avatar:' + uid(p.uid)]};
        }
        return rel ? media(rel) : notFound('This picture');
    });
    route('GET', '/api/v4/users/:uid/image/default', function (req, p) {
        var rel = S.media['/api/v4/users/' + uid(p.uid) + '/image'];
        return rel ? media(rel) : notFound('This picture');
    });
    route('POST', '/api/v4/users/:uid/image', function (req, p) {
        var file = req.body instanceof FormData ? req.body.get('image') : null;
        if (file) {
            S.blobs['avatar:' + uid(p.uid)] = file;
            S.me.last_picture_update = now();
            emit('user_updated', {user: S.me});
        }
        return ok();
    });
    route('DELETE', '/api/v4/users/:uid/image', function () {
        delete S.blobs['avatar:' + S.me.id];
        S.me.last_picture_update = now();
        emit('user_updated', {user: S.me});
        return ok();
    });
    route('GET', '/api/v4/users/:uid', function (req, p) {
        var u = user(p.uid);
        return u ? json(u) : notFound('This person');
    });
    function patchMe(changes) {
        Object.assign(S.me, changes, {update_at: now()});
        emit('user_updated', {user: S.me});
        return json(S.me);
    }
    route('PUT', '/api/v4/users/:uid/patch', function (req) {
        return patchMe(req.body || {});
    });
    route('PUT', '/api/v4/users/:uid', function (req) {
        return patchMe(req.body || {});
    });
    route('PUT', '/api/v4/users/:uid/password', function () {
        return forbidden('Passwords can\'t be changed in the demo.');
    });
    route('PUT', '/api/v4/users/:uid/status/custom', function (req) {
        var props = Object.assign({}, S.me.props || {});
        props.customStatus = JSON.stringify(req.body || {});
        return patchMe({props: props}) && ok();
    });
    route('DELETE', '/api/v4/users/:uid/status/custom', function () {
        var props = Object.assign({}, S.me.props || {});
        props.customStatus = '';
        patchMe({props: props});
        return ok();
    });
    route('POST', '/api/v4/users/:uid/status/custom/recent/delete', function () {
        return ok();
    });
    route('GET', '/api/v4/users/:uid/status', function (req, p) {
        return json(S.statuses[uid(p.uid)] || {user_id: uid(p.uid), status: 'offline'});
    });
    route('PUT', '/api/v4/users/:uid/status', function (req, p) {
        var st = Object.assign(S.statuses[uid(p.uid)] || {}, req.body || {}, {user_id: uid(p.uid), last_activity_at: now()});
        S.statuses[st.user_id] = st;
        emit('status_change', {status: st.status, user_id: st.user_id});
        return json(st);
    });
    route('POST', '/api/v4/users/status/ids', function (req) {
        return json((req.body || []).map(function (id) {
            return S.statuses[id] || {user_id: id, status: 'offline', manual: false, last_activity_at: 0};
        }));
    });
    ['sessions', 'audits', 'tokens', 'oauth/apps/authorized', 'uploads'].forEach(function (what) {
        route('GET', '/api/v4/users/:uid/' + what, function () {
            return json([]);
        });
    });
    route('GET', '/api/v4/users/:uid/teams', function () {
        return json(values(S.teams));
    });
    route('GET', '/api/v4/users/:uid/teams/members', function () {
        return json(values(S.myTeamMembers));
    });
    route('GET', '/api/v4/users/:uid/teams/unread', function () {
        return json(teamUnreads());
    });
    route('GET', '/api/v4/users/:uid/teams/:tid/unread', function (req, p) {
        return json(teamUnreads().find(function (u) {
            return u.team_id === p.tid;
        }) || {team_id: p.tid, msg_count: 0, mention_count: 0});
    });

    // --- teams ---------------------------------------------------------------------------------------------------

    function teamUnreads() {
        return values(S.teams).map(function (t) {
            var out = {team_id: t.id, msg_count: 0, mention_count: 0, mention_count_root: 0, msg_count_root: 0, urgent_mention_count: 0,
                thread_count: 0, thread_mention_count: 0, thread_urgent_mention_count: 0};
            values(S.channels).forEach(function (c) {
                var m = S.myMembers[c.id];
                if (!m || c.team_id !== t.id || c.delete_at) {
                    return;
                }
                out.msg_count += Math.max(0, (c.total_msg_count || 0) - (m.msg_count || 0));
                out.msg_count_root += Math.max(0, (c.total_msg_count_root || 0) - (m.msg_count_root || 0));
                out.mention_count += m.mention_count || 0;
                out.mention_count_root += m.mention_count_root || 0;
            });
            values(S.threads).forEach(function (th) {
                if (th.team_id === t.id && th.unread_replies) {
                    out.thread_count += 1;
                    out.thread_mention_count += th.unread_mentions || 0;
                }
            });
            return out;
        });
    }

    function teamByName(name) {
        return values(S.teams).find(function (t) {
            return t.name === name;
        });
    }

    route('GET', '/api/v4/teams', function () {
        return json(values(S.teams));
    });
    route('GET', '/api/v4/teams/name/:name/exists', function (req, p) {
        return json({exists: Boolean(teamByName(p.name))});
    });
    route('GET', '/api/v4/teams/name/:name', function (req, p) {
        var t = teamByName(p.name);
        return t ? json(t) : notFound('This team');
    });
    route('GET', '/api/v4/teams/name/:tname/channels/name/:cname', function (req, p) {
        var t = teamByName(p.tname);
        var c = t && channelByName(t.id, p.cname);
        return c ? json(c) : notFound('This channel');
    });
    route('GET', '/api/v4/teams/:tid', function (req, p) {
        return S.teams[p.tid] ? json(S.teams[p.tid]) : notFound('This team');
    });
    route('GET', '/api/v4/teams/:tid/image', function (req, p) {
        var rel = S.media['/api/v4/teams/' + p.tid + '/image'];
        return rel ? media(rel) : notFound('This icon');
    });
    route('GET', '/api/v4/teams/:tid/stats', function (req, p) {
        var ids = teamMemberIds(p.tid);
        return json(S.teamStats[p.tid] || {team_id: p.tid, total_member_count: ids.length, active_member_count: ids.length});
    });
    route('GET', '/api/v4/teams/:tid/members', function (req, p) {
        var page = int(req.query.get('page'), 0);
        var per = int(req.query.get('per_page'), 60);
        return json((S.teamMemberLists[p.tid] || []).slice(page * per, page * per + per));
    });
    route('POST', '/api/v4/teams/:tid/members/ids', function (req, p) {
        var ids = req.body || [];
        return json((S.teamMemberLists[p.tid] || []).filter(function (m) {
            return ids.indexOf(m.user_id) >= 0;
        }));
    });
    route('GET', '/api/v4/teams/:tid/members/:uid', function (req, p) {
        var m = (S.teamMemberLists[p.tid] || []).find(function (x) {
            return x.user_id === uid(p.uid);
        }) || (uid(p.uid) === S.me.id && S.myTeamMembers[p.tid]);
        return m ? json(m) : notFound('This member');
    });
    route('GET', '/api/v4/teams/:tid/commands/autocomplete_suggestions', function (req, p) {
        var input = (req.query.get('user_input') || '').toLowerCase();
        return json((S.commands[p.tid] || []).filter(function (c) {
            return ('/' + (c.Complete || c.Suggestion || '')).toLowerCase().indexOf(input) === 0 || (c.Suggestion || '').toLowerCase().indexOf(input.replace(/^\//, '')) === 0;
        }));
    });
    route('GET', '/api/v4/teams/:tid/commands', function () {
        return json([]);
    });
    route('POST', '/api/v4/commands/execute', function (req) {
        var b = req.body || {};
        ephemeral(b.channel_id, b.root_id, 'Slash commands don\'t run in this demo: try the menus and buttons instead.');
        return json({response_type: 'ephemeral', text: ''});
    });

    // --- channels ------------------------------------------------------------------------------------------------

    function channelByName(tid, name) {
        return values(S.channels).find(function (c) {
            return c.name === name && (c.team_id === tid || !c.team_id);
        });
    }

    function myChannels(tid) {
        return values(S.channels).filter(function (c) {
            return S.myMembers[c.id] && (!tid || c.team_id === tid || !c.team_id);
        });
    }

    route('GET', '/api/v4/users/:uid/teams/:tid/channels', function (req, p) {
        var includeDeleted = req.query.get('include_deleted') === 'true';
        return json(myChannels(p.tid).filter(function (c) {
            return includeDeleted || !c.delete_at;
        }));
    });
    route('GET', '/api/v4/users/:uid/teams/:tid/channels/members', function (req, p) {
        return json(myChannels(p.tid).map(function (c) {
            return S.myMembers[c.id];
        }));
    });
    route('GET', '/api/v4/users/:uid/channels', function (req) {
        var page = int(req.query.get('page'), 0);
        var list = myChannels(null);
        return json(page > 0 ? [] : list);
    });
    route('GET', '/api/v4/users/:uid/channel_members', function (req) {
        var page = int(req.query.get('page'), 0);
        if (page === -1) {
            // All of them at once, one per line, as the server streams them.
            return {text: values(S.myMembers).map(function (m) {
                return JSON.stringify(m);
            }).join('\n') + '\n', headers: {'Content-Type': 'application/x-ndjson'}};
        }
        return json(page > 0 ? [] : values(S.myMembers));
    });
    route('GET', '/api/v4/channels/:cid', function (req, p) {
        return S.channels[p.cid] ? json(S.channels[p.cid]) : notFound('This channel');
    });
    route('GET', '/api/v4/teams/:tid/channels/name/:name', function (req, p) {
        var c = channelByName(p.tid, p.name);
        return c ? json(c) : notFound('This channel');
    });
    function publicChannels(tid) {
        var list = (S.publicChannels[tid] || []).map(function (c) {
            return S.channels[c.id] || c;
        });
        values(S.channels).forEach(function (c) {
            if (c.team_id === tid && c.type === 'O' && !list.some(function (x) {
                return x.id === c.id;
            })) {
                list.push(c);
            }
        });
        return list;
    }
    route('GET', '/api/v4/teams/:tid/channels', function (req, p) {
        var page = int(req.query.get('page'), 0);
        var per = int(req.query.get('per_page'), 60);
        return json(publicChannels(p.tid).filter(function (c) {
            return !c.delete_at;
        }).slice(page * per, page * per + per));
    });
    route('GET', '/api/v4/teams/:tid/channels/deleted', function (req, p) {
        return json(publicChannels(p.tid).filter(function (c) {
            return c.delete_at;
        }));
    });
    route('GET', '/api/v4/teams/:tid/channels/private', function (req, p) {
        return json(myChannels(p.tid).filter(function (c) {
            return c.type === 'P';
        }));
    });
    function searchChannels(tid, term) {
        term = (term || '').toLowerCase();
        return publicChannels(tid).concat(myChannels(tid).filter(function (c) {
            return c.type === 'P';
        })).filter(function (c, i, all) {
            return all.findIndex(function (x) {
                return x.id === c.id;
            }) === i && ((c.name || '').toLowerCase().indexOf(term) >= 0 || (c.display_name || '').toLowerCase().indexOf(term) >= 0);
        });
    }
    route('POST', '/api/v4/teams/:tid/channels/search', function (req, p) {
        return json(searchChannels(p.tid, (req.body || {}).term));
    });
    route('GET', '/api/v4/teams/:tid/channels/autocomplete', function (req, p) {
        return json(searchChannels(p.tid, req.query.get('name')));
    });
    route('GET', '/api/v4/teams/:tid/channels/search_autocomplete', function (req, p) {
        return json(searchChannels(p.tid, req.query.get('name')));
    });
    route('POST', '/api/v4/channels/search', function (req) {
        var term = (req.body || {}).term;
        var all = [];
        Object.keys(S.teams).forEach(function (tid) {
            all = all.concat(searchChannels(tid, term));
        });
        return json(all);
    });
    route('GET', '/api/v4/channels/:cid/stats', function (req, p) {
        var ids = channelMemberIds(p.cid);
        var st = S.channelStats[p.cid] || {};
        return json(Object.assign({channel_id: p.cid, member_count: ids.length, guest_count: 0, pinnedpost_count: 0, files_count: 0}, st, {
            member_count: ids.length || st.member_count || 0,
            pinnedpost_count: (S.byChannel[p.cid] || []).filter(function (id) {
                return S.posts[id].is_pinned && !S.posts[id].delete_at;
            }).length,
        }));
    });
    route('GET', '/api/v4/channels/:cid/members', function (req, p) {
        var page = int(req.query.get('page'), 0);
        var per = int(req.query.get('per_page'), 60);
        return json((S.channelMembers[p.cid] || []).slice(page * per, page * per + per));
    });
    route('POST', '/api/v4/channels/:cid/members/ids', function (req, p) {
        var ids = req.body || [];
        return json((S.channelMembers[p.cid] || []).filter(function (m) {
            return ids.indexOf(m.user_id) >= 0;
        }));
    });
    route('GET', '/api/v4/channels/:cid/members/:uid', function (req, p) {
        var id = uid(p.uid);
        if (id === S.me.id) {
            return S.myMembers[p.cid] ? json(S.myMembers[p.cid]) : notFound('This membership');
        }
        var m = (S.channelMembers[p.cid] || []).find(function (x) {
            return x.user_id === id;
        });
        return m ? json(m) : notFound('This membership');
    });
    route('PUT', '/api/v4/channels/:cid/members/:uid/notify_props', function (req, p) {
        var m = S.myMembers[p.cid];
        if (m) {
            m.notify_props = Object.assign({}, m.notify_props, req.body || {});
            emit('channel_member_updated', {channelMember: JSON.stringify(m)}, {user_id: S.me.id});
        }
        return ok();
    });
    route('POST', '/api/v4/channels/members/:uid/view', function (req) {
        var b = req.body || {};
        var times = {};
        if (b.channel_id) {
            currentChannelId = b.channel_id;
            markViewed(b.channel_id);
            times[b.channel_id] = now();
        }
        return ok({last_viewed_at_times: times});
    });
    route('POST', '/api/v4/channels/members/:uid/mark_read', function (req) {
        (req.body || []).forEach(markViewed);
        return ok();
    });
    function markViewed(cid) {
        var m = S.myMembers[cid];
        var c = S.channels[cid];
        if (!m || !c) {
            return;
        }
        m.last_viewed_at = now();
        m.msg_count = c.total_msg_count || 0;
        m.msg_count_root = c.total_msg_count_root || 0;
        m.mention_count = 0;
        m.mention_count_root = 0;
        m.urgent_mention_count = 0;
        emit('multiple_channels_viewed', {channel_times: (function () {
            var o = {};
            o[cid] = m.last_viewed_at;
            return o;
        }())}, {user_id: S.me.id});
    }
    route('GET', '/api/v4/channels/:cid/timezones', function () {
        return json([]);
    });
    route('GET', '/api/v4/channels/:cid/member_counts_by_group', function () {
        return json([]);
    });
    route('GET', '/api/v4/channels/:cid/moderations', function () {
        return json([]);
    });
    route('GET', '/api/v4/channels/:cid/common_teams', function () {
        return json(values(S.teams));
    });
    route('GET', '/api/v4/channels/:cid/pinned', function (req, p) {
        var ids = (S.byChannel[p.cid] || []).filter(function (id) {
            return S.posts[id].is_pinned && !S.posts[id].delete_at;
        });
        return json(postList(ids));
    });

    function memberFor(c, userId) {
        return {
            channel_id: c.id, user_id: userId, roles: 'channel_user', last_viewed_at: now(), msg_count: c.total_msg_count || 0,
            msg_count_root: c.total_msg_count_root || 0, mention_count: 0, mention_count_root: 0, urgent_mention_count: 0,
            notify_props: {desktop: 'default', email: 'default', mark_unread: 'all', push: 'default', ignore_channel_mentions: 'default'},
            last_update_at: now(), scheme_guest: false, scheme_user: true, scheme_admin: false, explicit_roles: '',
        };
    }

    function newChannel(fields) {
        var c = Object.assign({
            id: newId(), create_at: now(), update_at: now(), delete_at: 0, team_id: '', type: 'O', display_name: '', name: '',
            header: '', purpose: '', last_post_at: now(), total_msg_count: 0, extra_update_at: 0, creator_id: S.me.id,
            scheme_id: null, props: null, group_constrained: null, shared: null, total_msg_count_root: 0, policy_id: null,
            last_root_post_at: now(),
        }, fields);
        S.channels[c.id] = c;
        S.myMembers[c.id] = memberFor(c, S.me.id);
        S.channelMembers[c.id] = [memberFor(c, S.me.id)];
        S.byChannel[c.id] = [];
        return c;
    }

    function addToCategory(c, type) {
        Object.keys(S.categories).forEach(function (tid) {
            if (c.team_id && c.team_id !== tid) {
                return;
            }
            var cat = ((S.categories[tid] || {}).categories || []).find(function (x) {
                return x.type === type;
            });
            if (cat && cat.channel_ids.indexOf(c.id) < 0) {
                cat.channel_ids.unshift(c.id);
                emit('sidebar_category_updated', {updatedCategories: JSON.stringify([cat])}, {user_id: S.me.id, team_id: tid});
            }
        });
    }

    route('POST', '/api/v4/channels', function (req) {
        var b = req.body || {};
        var c = newChannel({team_id: b.team_id, type: b.type || 'O', display_name: b.display_name, name: b.name || newId(),
            header: b.header || '', purpose: b.purpose || ''});
        S.myMembers[c.id].roles = 'channel_user channel_admin';
        addToCategory(c, 'channels');
        emit('channel_created', {channel_id: c.id, team_id: c.team_id}, {user_id: S.me.id});
        return json(c, 201);
    });
    route('POST', '/api/v4/channels/direct', function (req) {
        var ids = (req.body || []).slice().sort();
        var name = ids.length === 1 ? ids[0] + '__' + ids[0] : ids.join('__');
        var c = values(S.channels).find(function (x) {
            return x.type === 'D' && x.name === name;
        });
        if (!c) {
            c = newChannel({type: 'D', name: name, display_name: ''});
            S.channelMembers[c.id] = ids.map(function (id) {
                return memberFor(c, id);
            });
            addToCategory(c, 'direct_messages');
            emit('direct_added', {creator_id: S.me.id, teammate_id: ids.find(function (id) {
                return id !== S.me.id;
            })}, {channel_id: c.id});
        }
        return json(c, 201);
    });
    route('POST', '/api/v4/channels/group', function (req) {
        var ids = (req.body || []).concat([S.me.id]).filter(function (v, i, a) {
            return a.indexOf(v) === i;
        });
        var c = newChannel({type: 'G', name: newId() + newId(), display_name: ids.map(function (id) {
            return (S.users[id] || {}).username;
        }).join(', ')});
        S.channelMembers[c.id] = ids.map(function (id) {
            return memberFor(c, id);
        });
        addToCategory(c, 'direct_messages');
        emit('group_added', {teammate_ids: JSON.stringify(ids)}, {channel_id: c.id});
        return json(c, 201);
    });
    route('POST', '/api/v4/channels/:cid/members', function (req, p) {
        var c = S.channels[p.cid];
        if (!c) {
            return notFound('This channel');
        }
        var who = (req.body || {}).user_id || S.me.id;
        var m = memberFor(c, who);
        S.channelMembers[c.id] = (S.channelMembers[c.id] || []).filter(function (x) {
            return x.user_id !== who;
        }).concat([m]);
        if (who === S.me.id) {
            S.myMembers[c.id] = m;
            addToCategory(c, 'channels');
        }
        emit('user_added', {team_id: c.team_id, user_id: who}, {channel_id: c.id});
        return json(m, 201);
    });
    route('DELETE', '/api/v4/channels/:cid/members/:uid', function (req, p) {
        var who = uid(p.uid);
        var c = S.channels[p.cid];
        S.channelMembers[p.cid] = (S.channelMembers[p.cid] || []).filter(function (x) {
            return x.user_id !== who;
        });
        if (who === S.me.id) {
            delete S.myMembers[p.cid];
        }
        emit('user_removed', {channel_id: p.cid, remover_id: S.me.id, user_id: who}, {user_id: who, team_id: c ? c.team_id : ''});
        return ok();
    });
    function patchChannel(cid, changes) {
        var c = S.channels[cid];
        if (!c) {
            return notFound('This channel');
        }
        Object.assign(c, changes, {update_at: now()});
        emit('channel_updated', {channel: JSON.stringify(c)}, {channel_id: c.id});
        return json(c);
    }
    route('PUT', '/api/v4/channels/:cid/patch', function (req, p) {
        return patchChannel(p.cid, req.body || {});
    });
    route('PUT', '/api/v4/channels/:cid', function (req, p) {
        return patchChannel(p.cid, req.body || {});
    });
    route('DELETE', '/api/v4/channels/:cid', function (req, p) {
        patchChannel(p.cid, {delete_at: now()});
        emit('channel_deleted', {channel_id: p.cid, delete_at: now()}, {team_id: (S.channels[p.cid] || {}).team_id});
        return ok();
    });
    route('POST', '/api/v4/channels/:cid/restore', function (req, p) {
        return patchChannel(p.cid, {delete_at: 0});
    });
    route('POST', '/api/v4/channels/:cid/convert', function (req, p) {
        return patchChannel(p.cid, {type: 'P'});
    });
    route('PUT', '/api/v4/channels/:cid/privacy', function (req, p) {
        return patchChannel(p.cid, {type: (req.body || {}).privacy || 'P'});
    });

    // --- sidebar categories --------------------------------------------------------------------------------------

    function categoriesOf(tid) {
        S.categories[tid] = S.categories[tid] || {categories: [], order: []};
        return S.categories[tid];
    }
    route('GET', '/api/v4/users/:uid/teams/:tid/channels/categories', function (req, p) {
        return json(categoriesOf(p.tid));
    });
    route('GET', '/api/v4/users/:uid/teams/:tid/channels/categories/order', function (req, p) {
        return json(categoriesOf(p.tid).order);
    });
    route('PUT', '/api/v4/users/:uid/teams/:tid/channels/categories/order', function (req, p) {
        categoriesOf(p.tid).order = req.body || [];
        emit('sidebar_category_order_updated', {order: req.body || []}, {user_id: S.me.id, team_id: p.tid});
        return json(req.body || []);
    });
    function upsertCategories(tid, cats) {
        var data = categoriesOf(tid);
        cats.forEach(function (cat) {
            var i = data.categories.findIndex(function (x) {
                return x.id === cat.id;
            });
            // A channel is in one category: moving it removes it from the others.
            data.categories.forEach(function (other) {
                if (other.id !== cat.id) {
                    other.channel_ids = other.channel_ids.filter(function (id) {
                        return (cat.channel_ids || []).indexOf(id) < 0;
                    });
                }
            });
            if (i >= 0) {
                data.categories[i] = Object.assign({}, data.categories[i], cat);
            } else {
                data.categories.push(cat);
            }
        });
        emit('sidebar_category_updated', {updatedCategories: JSON.stringify(data.categories)}, {user_id: S.me.id, team_id: tid});
    }
    route('PUT', '/api/v4/users/:uid/teams/:tid/channels/categories', function (req, p) {
        upsertCategories(p.tid, req.body || []);
        return json(req.body || []);
    });
    route('PUT', '/api/v4/users/:uid/teams/:tid/channels/categories/:catid', function (req, p) {
        upsertCategories(p.tid, [req.body || {}]);
        return json(req.body || {});
    });
    route('GET', '/api/v4/users/:uid/teams/:tid/channels/categories/:catid', function (req, p) {
        var cat = categoriesOf(p.tid).categories.find(function (x) {
            return x.id === p.catid;
        });
        return cat ? json(cat) : notFound('This category');
    });
    route('POST', '/api/v4/users/:uid/teams/:tid/channels/categories', function (req, p) {
        var cat = Object.assign({id: newId(), user_id: S.me.id, team_id: p.tid, type: 'custom', sorting: '', muted: false, collapsed: false,
            channel_ids: [], sort_order: 0}, req.body || {});
        var data = categoriesOf(p.tid);
        data.categories.push(cat);
        data.order.splice(Math.min(1, data.order.length), 0, cat.id);
        upsertCategories(p.tid, [cat]);
        emit('sidebar_category_created', {category_id: cat.id}, {user_id: S.me.id, team_id: p.tid});
        return json(cat, 201);
    });
    route('DELETE', '/api/v4/users/:uid/teams/:tid/channels/categories/:catid', function (req, p) {
        var data = categoriesOf(p.tid);
        var cat = data.categories.find(function (x) {
            return x.id === p.catid;
        });
        data.categories = data.categories.filter(function (x) {
            return x.id !== p.catid;
        });
        data.order = data.order.filter(function (x) {
            return x !== p.catid;
        });
        var channelsCat = data.categories.find(function (x) {
            return x.type === 'channels';
        });
        if (cat && channelsCat) {
            channelsCat.channel_ids = cat.channel_ids.concat(channelsCat.channel_ids);
        }
        emit('sidebar_category_deleted', {category_id: p.catid}, {user_id: S.me.id, team_id: p.tid});
        return ok();
    });

    // --- preferences ---------------------------------------------------------------------------------------------

    route('GET', '/api/v4/users/:uid/preferences', function () {
        return json(S.preferences);
    });
    route('GET', '/api/v4/users/:uid/preferences/:category', function (req, p) {
        return json(S.preferences.filter(function (x) {
            return x.category === p.category;
        }));
    });
    route('GET', '/api/v4/users/:uid/preferences/:category/name/:name', function (req, p) {
        var pref = S.preferences.find(function (x) {
            return x.category === p.category && x.name === p.name;
        });
        return pref ? json(pref) : notFound('This preference');
    });
    route('PUT', '/api/v4/users/:uid/preferences', function (req) {
        var list = req.body || [];
        list.forEach(function (pref) {
            pref.user_id = S.me.id;
            var i = S.preferences.findIndex(function (x) {
                return x.category === pref.category && x.name === pref.name;
            });
            if (i >= 0) {
                S.preferences[i] = pref;
            } else {
                S.preferences.push(pref);
            }
        });
        emit('preferences_changed', {preferences: JSON.stringify(list)}, {user_id: S.me.id});
        return ok();
    });
    route('POST', '/api/v4/users/:uid/preferences/delete', function (req) {
        var list = req.body || [];
        S.preferences = S.preferences.filter(function (x) {
            return !list.some(function (d) {
                return d.category === x.category && d.name === x.name;
            });
        });
        emit('preferences_deleted', {preferences: JSON.stringify(list)}, {user_id: S.me.id});
        return ok();
    });

    // --- posts ---------------------------------------------------------------------------------------------------

    function visible(p) {
        return p && !p.delete_at;
    }

    function postList(ids, extra) {
        var posts = {};
        ids.forEach(function (id) {
            if (S.posts[id]) {
                posts[id] = S.posts[id];
            }
        });
        return Object.assign({order: ids.filter(function (id) {
            return posts[id];
        }), posts: posts, next_post_id: '', prev_post_id: '', has_next: false, first_inaccessible_post_time: 0}, extra || {});
    }

    // channelPosts: newest first, as the server lists them; replies left out when threads are collapsed.
    function channelPosts(cid, collapsed) {
        return (S.byChannel[cid] || []).filter(function (id) {
            var p = S.posts[id];
            return visible(p) && (!collapsed || !p.root_id);
        });
    }

    // withRoots adds the root posts of the replies listed, as the server does.
    function withRoots(list) {
        var posts = list.posts;
        list.order.forEach(function (id) {
            var p = posts[id];
            if (p && p.root_id && !posts[p.root_id] && S.posts[p.root_id]) {
                posts[p.root_id] = S.posts[p.root_id];
            }
        });
        return list;
    }

    route('GET', '/api/v4/channels/:cid/posts', function (req, p) {
        var q = req.query;
        var collapsed = q.get('collapsedThreads') === 'true';
        var ids = channelPosts(p.cid, collapsed);
        var per = int(q.get('per_page'), 60);
        var page = int(q.get('page'), 0);
        var since = int(q.get('since'), 0);
        if (since) {
            return json(withRoots(postList((S.byChannel[p.cid] || []).filter(function (id) {
                return S.posts[id].update_at >= since && (!collapsed || !S.posts[id].root_id);
            }))));
        }
        var before = q.get('before');
        var after = q.get('after');
        if (before) {
            var bi = ids.indexOf(before);
            var older = bi >= 0 ? ids.slice(bi + 1) : [];
            var chunk = older.slice(page * per, page * per + per);
            return json(withRoots(postList(chunk, {next_post_id: before, prev_post_id: older[page * per + per] || ''})));
        }
        if (after) {
            var ai = ids.indexOf(after);
            var newer = ai >= 0 ? ids.slice(0, ai) : [];
            var start = Math.max(0, newer.length - per * (page + 1));
            var part = newer.slice(start, newer.length - per * page);
            return json(withRoots(postList(part, {next_post_id: start > 0 ? newer[start - 1] : '', prev_post_id: after})));
        }
        var slice = ids.slice(page * per, page * per + per);
        return json(withRoots(postList(slice, {prev_post_id: ids[page * per + per] || ''})));
    });
    route('GET', '/api/v4/users/:uid/channels/:cid/posts/unread', function (req, p) {
        var collapsed = req.query.get('collapsedThreads') === 'true';
        return json(withRoots(postList(channelPosts(p.cid, collapsed))));
    });
    route('GET', '/api/v4/posts/:pid', function (req, p) {
        var post = S.posts[p.pid];
        return post ? json(post) : notFound('This message');
    });
    route('POST', '/api/v4/posts/ids', function (req) {
        return json((req.body || []).map(function (id) {
            return S.posts[id];
        }).filter(Boolean));
    });
    route('GET', '/api/v4/posts/:pid/thread', function (req, p) {
        var root = S.posts[p.pid];
        if (!root) {
            return notFound('This thread');
        }
        var rootId = root.root_id || root.id;
        var replies = (S.replies[rootId] || []).filter(function (id) {
            return visible(S.posts[id]);
        });
        if (req.query.get('direction') === 'down') {
            // The root first, then the replies from the oldest: the thread panel reads them that way.
            replies.sort(function (a, b) {
                return S.posts[a].create_at - S.posts[b].create_at;
            });
            return json(postList([rootId].concat(replies), {has_next: false}));
        }
        var ids = [rootId].concat(replies);
        ids.sort(function (a, b) {
            return S.posts[b].create_at - S.posts[a].create_at;
        });
        return json(postList(ids));
    });
    route('GET', '/api/v4/posts/:pid/files/info', function (req, p) {
        var post = S.posts[p.pid];
        return json(post ? (post.metadata || {}).files || [] : []);
    });
    route('GET', '/api/v4/posts/:pid/reactions', function (req, p) {
        var post = S.posts[p.pid];
        return json(post ? (post.metadata || {}).reactions || [] : []);
    });
    route('POST', '/api/v4/posts/ids/reactions', function (req) {
        var out = {};
        (req.body || []).forEach(function (id) {
            out[id] = S.posts[id] ? (S.posts[id].metadata || {}).reactions || [] : [];
        });
        return json(out);
    });
    route('GET', '/api/v4/posts/:pid/edit_history', function () {
        return json([]);
    });

    // createPost adds a post as someone: the visitor, or one of the demo's people (the canned replies).
    function createPost(fields, author) {
        var c = S.channels[fields.channel_id];
        if (!c) {
            return null;
        }
        var t = now();
        var post = Object.assign({
            id: newId(), create_at: t, update_at: t, edit_at: 0, delete_at: 0, is_pinned: false, user_id: author || S.me.id,
            channel_id: c.id, root_id: '', original_id: '', message: '', type: '', props: {}, hashtags: '', file_ids: [],
            pending_post_id: '', remote_id: '', reply_count: 0, last_reply_at: 0, participants: null, metadata: {},
        }, fields, {create_at: t, update_at: t, user_id: author || S.me.id});
        post.metadata = Object.assign({}, post.metadata || {});
        var files = (post.file_ids || []).map(function (id) {
            return S.files[id];
        }).filter(Boolean);
        files.forEach(function (f) {
            f.post_id = post.id;
        });
        if (files.length) {
            post.metadata.files = files;
        } else {
            delete post.metadata.files;
        }
        var emojis = (post.message.match(/:([a-z0-9_+-]+):/g) || []).map(function (s) {
            var name = s.slice(1, -1);
            return values(S.emoji).find(function (e) {
                return e.name === name;
            });
        }).filter(Boolean);
        if (emojis.length) {
            post.metadata.emojis = emojis;
        }
        S.posts[post.id] = post;
        (S.byChannel[c.id] = S.byChannel[c.id] || []).unshift(post.id);
        c.last_post_at = t;
        c.total_msg_count = (c.total_msg_count || 0) + 1;
        if (!post.root_id) {
            c.total_msg_count_root = (c.total_msg_count_root || 0) + 1;
            c.last_root_post_at = t;
        }
        if (post.root_id && S.posts[post.root_id]) {
            var root = S.posts[post.root_id];
            (S.replies[root.id] = S.replies[root.id] || []).push(post.id);
            root.reply_count = (root.reply_count || 0) + 1;
            root.last_reply_at = t;
            var who = (root.participants || []).map(function (u) {
                return u.id;
            });
            if (who.indexOf(post.user_id) < 0 && S.users[post.user_id]) {
                root.participants = (root.participants || []).concat([S.users[post.user_id]]);
            }
            post.reply_count = root.reply_count;
            threadReplied(root, post);
        }
        var mine = post.user_id === S.me.id;
        var m = S.myMembers[c.id];
        if (m && (mine || c.id === currentChannelId)) {
            m.msg_count = c.total_msg_count;
            m.msg_count_root = c.total_msg_count_root || 0;
            m.last_viewed_at = t;
        }
        var author_ = S.users[post.user_id] || {};
        var data = {
            channel_display_name: c.display_name, channel_name: c.name, channel_type: c.type, post: JSON.stringify(post),
            sender_name: '@' + (author_.username || ''), set_online: true, team_id: c.team_id || '',
        };
        if (!mine && (c.type === 'D' || post.message.indexOf('@' + S.me.username) >= 0)) {
            data.mentions = JSON.stringify([S.me.id]);
            if (m && c.id !== currentChannelId) {
                m.mention_count = (m.mention_count || 0) + 1;
            }
        }
        emit('posted', data, {channel_id: c.id});
        return post;
    }

    function threadReplied(root, reply) {
        var th = S.threads[root.id];
        var c = S.channels[root.channel_id] || {};
        if (!th && (reply.user_id === S.me.id || root.user_id === S.me.id)) {
            th = S.threads[root.id] = {id: root.id, reply_count: 0, last_reply_at: 0, last_viewed_at: 0, participants: [], is_following: true,
                unread_replies: 0, unread_mentions: 0, is_urgent: false, team_id: c.team_id || Object.keys(S.teams)[0]};
        }
        if (!th) {
            return;
        }
        th.reply_count = root.reply_count;
        th.last_reply_at = reply.create_at;
        th.participants = root.participants || [];
        if (reply.user_id === S.me.id) {
            th.last_viewed_at = reply.create_at;
            th.unread_replies = 0;
        } else {
            th.unread_replies = (th.unread_replies || 0) + 1;
        }
        emit('thread_updated', {thread: JSON.stringify(threadOut(th))}, {user_id: S.me.id, team_id: th.team_id});
    }

    route('POST', '/api/v4/posts', function (req) {
        var b = req.body || {};
        var post = createPost({channel_id: b.channel_id, root_id: b.root_id || '', message: b.message || '', type: b.type || '',
            props: b.props || {}, file_ids: b.file_ids || [], pending_post_id: b.pending_post_id || '', metadata: b.metadata || {}});
        if (!post) {
            return notFound('This channel');
        }
        if (window.DemoLife) {
            window.DemoLife.afterVisitorPost(post);
        }
        return json(post, 201);
    });
    function editPost(pid, changes) {
        var post = S.posts[pid];
        if (!post) {
            return notFound('This message');
        }
        var t = now();
        Object.assign(post, changes, {update_at: t});
        if (changes.message !== undefined) {
            post.edit_at = t;
        }
        emit('post_edited', {post: JSON.stringify(post)}, {channel_id: post.channel_id});
        return json(post);
    }
    route('PUT', '/api/v4/posts/:pid/patch', function (req, p) {
        var b = req.body || {};
        var changes = {};
        ['message', 'is_pinned', 'props', 'file_ids', 'has_reactions'].forEach(function (k) {
            if (b[k] !== undefined) {
                changes[k] = b[k];
            }
        });
        return editPost(p.pid, changes);
    });
    route('PUT', '/api/v4/posts/:pid', function (req, p) {
        var b = req.body || {};
        return editPost(p.pid, {message: b.message, props: b.props || (S.posts[p.pid] || {}).props});
    });
    route('POST', '/api/v4/posts/:pid/pin', function (req, p) {
        editPost(p.pid, {is_pinned: true});
        return ok();
    });
    route('POST', '/api/v4/posts/:pid/unpin', function (req, p) {
        editPost(p.pid, {is_pinned: false});
        return ok();
    });
    route('DELETE', '/api/v4/posts/:pid', function (req, p) {
        var post = S.posts[p.pid];
        if (!post) {
            return notFound('This message');
        }
        post.delete_at = now();
        post.update_at = now();
        emit('post_deleted', {post: JSON.stringify(post), delete_by: S.me.id}, {channel_id: post.channel_id});
        return ok();
    });
    route('POST', '/api/v4/posts/:pid/actions/:action', function (req, p) {
        var post = S.posts[p.pid];
        ephemeral(post && post.channel_id, post && (post.root_id || ''), 'Buttons of integrations don\'t reach their service in this demo.');
        return ok();
    });
    route('POST', '/api/v4/users/:uid/posts/:pid/set_unread', function (req, p) {
        var post = S.posts[p.pid];
        var m = post && S.myMembers[post.channel_id];
        if (m) {
            m.last_viewed_at = post.create_at - 1;
            var newer = (S.byChannel[post.channel_id] || []).filter(function (id) {
                return S.posts[id].create_at >= post.create_at;
            }).length;
            m.msg_count = Math.max(0, (S.channels[post.channel_id].total_msg_count || 0) - newer);
        }
        return json(Object.assign({team_id: (S.channels[post && post.channel_id] || {}).team_id, channel_id: post && post.channel_id,
            msg_count: m ? m.msg_count : 0, mention_count: 0, last_viewed_at: m ? m.last_viewed_at : 0}));
    });

    // ephemeral shows a message only the visitor sees, from the system.
    function ephemeral(cid, rootId, message) {
        if (!cid) {
            return;
        }
        var t = now();
        var post = {id: newId(), create_at: t, update_at: t, edit_at: 0, delete_at: 0, user_id: S.me.id, channel_id: cid, root_id: rootId || '',
            message: message, type: 'system_ephemeral', props: {}, metadata: {}, reply_count: 0};
        setTimeout(function () {
            emit('ephemeral_message', {post: JSON.stringify(post)}, {channel_id: cid, user_id: S.me.id});
        }, 200);
    }

    // --- reactions ---------------------------------------------------------------------------------------------------

    route('POST', '/api/v4/reactions', function (req) {
        var b = req.body || {};
        var post = S.posts[b.post_id];
        if (!post) {
            return notFound('This message');
        }
        var r = {user_id: S.me.id, post_id: post.id, emoji_name: b.emoji_name, create_at: now(), update_at: now(), delete_at: 0, remote_id: '', channel_id: post.channel_id};
        addReaction(post, r);
        return json(r, 201);
    });
    function addReaction(post, r) {
        post.metadata = post.metadata || {};
        var list = (post.metadata.reactions || []).filter(function (x) {
            return !(x.user_id === r.user_id && x.emoji_name === r.emoji_name);
        });
        list.push(r);
        post.metadata.reactions = list;
        post.has_reactions = true;
        post.update_at = now();
        emit('reaction_added', {reaction: JSON.stringify(r)}, {channel_id: post.channel_id});
    }
    route('DELETE', '/api/v4/users/:uid/posts/:pid/reactions/:name', function (req, p) {
        var post = S.posts[p.pid];
        if (!post) {
            return notFound('This message');
        }
        var who = uid(p.uid);
        var removed = ((post.metadata || {}).reactions || []).find(function (x) {
            return x.user_id === who && x.emoji_name === p.name;
        });
        post.metadata.reactions = (post.metadata.reactions || []).filter(function (x) {
            return x !== removed;
        });
        post.has_reactions = post.metadata.reactions.length > 0;
        if (removed) {
            emit('reaction_removed', {reaction: JSON.stringify(removed)}, {channel_id: post.channel_id});
        }
        return ok();
    });

    // --- saved posts, mentions, search ---------------------------------------------------------------------------------

    route('GET', '/api/v4/users/:uid/posts/flagged', function () {
        var ids = S.preferences.filter(function (x) {
            return x.category === 'flagged_post' && x.value === 'true';
        }).map(function (x) {
            return x.name;
        }).filter(function (id) {
            return visible(S.posts[id]);
        });
        ids.sort(function (a, b) {
            return S.posts[b].create_at - S.posts[a].create_at;
        });
        return json(postList(ids));
    });

    function searchPosts(teamId, body) {
        var terms = (body.terms || '').trim();
        var from = [];
        var inCh = [];
        var words = [];
        terms.split(/\s+/).forEach(function (w) {
            var m = /^(from|in|on|after|before|-from|-in):(.+)$/i.exec(w);
            if (m && m[1].toLowerCase() === 'from') {
                from.push(m[2].replace(/^@/, ''));
            } else if (m && m[1].toLowerCase() === 'in') {
                inCh.push(m[2].replace(/^~/, ''));
            } else if (!m && w) {
                words.push(w.replace(/^"|"$/g, '').replace(/\*$/, '').toLowerCase());
            }
        });
        var ids = values(S.posts).filter(function (p) {
            var c = S.channels[p.channel_id];
            if (!visible(p) || !c || !S.myMembers[c.id] || p.type.indexOf('system_') === 0) {
                return false;
            }
            if (teamId && c.team_id && c.team_id !== teamId) {
                return false;
            }
            if (from.length && from.indexOf((S.users[p.user_id] || {}).username) < 0) {
                return false;
            }
            if (inCh.length && inCh.indexOf(c.name) < 0) {
                return false;
            }
            var text = (p.message || '').toLowerCase();
            var match = words.filter(function (w) {
                return text.indexOf(w.replace(/^@/, '@')) >= 0;
            });
            return body.is_or_search ? match.length > 0 || !words.length : match.length === words.length;
        }).sort(function (a, b) {
            return b.create_at - a.create_at;
        }).map(function (p) {
            return p.id;
        });
        var per = body.per_page || 20;
        var page = body.page || 0;
        var part = ids.slice(page * per, page * per + per);
        var matches = {};
        part.forEach(function (id) {
            matches[id] = words;
        });
        return postList(part, {matches: matches, has_next: ids.length > (page + 1) * per});
    }
    route('POST', '/api/v4/teams/:tid/posts/search', function (req, p) {
        return json(searchPosts(p.tid, req.body || {}));
    });
    route('POST', '/api/v4/posts/search', function (req) {
        return json(searchPosts((req.body || {}).team_id || '', req.body || {}));
    });
    function searchFiles(teamId, body) {
        var term = ((body || {}).terms || '').toLowerCase();
        var inChannel = '';
        term = term.replace(/(^|\s)channel:(\S+)/, function (m, sp, cid) {
            inChannel = cid;
            return '';
        }).trim().replace(/\*$/, '');
        var infos = {};
        var order = [];
        values(S.files).forEach(function (f) {
            var post = S.posts[f.post_id];
            if (post && visible(post) && (!inChannel || post.channel_id === inChannel) && (f.name || '').toLowerCase().indexOf(term) >= 0) {
                infos[f.id] = Object.assign({}, f, {channel_id: post.channel_id});
                order.push(f.id);
            }
        });
        return {order: order, file_infos: infos, next_file_info_id: '', prev_file_info_id: '', has_next: false};
    }
    route('POST', '/api/v4/teams/:tid/files/search', function (req, p) {
        return json(searchFiles(p.tid, req.body));
    });
    route('POST', '/api/v4/files/search', function (req) {
        return json(searchFiles('', req.body));
    });
    route('GET', '/api/v4/channels/:cid/files', function (req, p) {
        return json(values(S.files).filter(function (f) {
            return S.posts[f.post_id] && S.posts[f.post_id].channel_id === p.cid;
        }));
    });

    // --- threads (collapsed reply threads) ------------------------------------------------------------------------

    function threadOut(th) {
        return Object.assign({}, th, {post: S.posts[th.id]});
    }
    function threadsOf(tid, q) {
        var list = values(S.threads).filter(function (th) {
            return (th.team_id === tid || !tid) && S.posts[th.id] && visible(S.posts[th.id]) && th.is_following !== false;
        });
        if (q.get('unread') === 'true') {
            list = list.filter(function (th) {
                return th.unread_replies > 0;
            });
        }
        list.sort(function (a, b) {
            return b.last_reply_at - a.last_reply_at;
        });
        var before = q.get('before');
        if (before) {
            var bi = list.findIndex(function (th) {
                return th.id === before;
            });
            list = bi >= 0 ? list.slice(bi + 1) : [];
        }
        var after = q.get('after');
        if (after) {
            var ai = list.findIndex(function (th) {
                return th.id === after;
            });
            list = ai >= 0 ? list.slice(0, ai) : [];
        }
        return list;
    }
    route('GET', '/api/v4/users/:uid/teams/:tid/threads', function (req, p) {
        var all = threadsOf(p.tid, new URLSearchParams());
        var list = threadsOf(p.tid, req.query).slice(0, int(req.query.get('per_page'), 25));
        var unread = all.filter(function (th) {
            return th.unread_replies > 0;
        });
        if (req.query.get('totalsOnly') === 'true') {
            list = [];
        }
        return json({
            threads: req.query.get('threadsOnly') === 'true' || req.query.get('totalsOnly') !== 'true' ? list.map(threadOut) : [],
            total: all.length,
            total_unread_threads: unread.length,
            total_unread_mentions: unread.reduce(function (n, th) {
                return n + (th.unread_mentions || 0);
            }, 0),
            total_unread_urgent_mentions: 0,
        });
    });
    route('GET', '/api/v4/users/:uid/teams/:tid/threads/:thid', function (req, p) {
        var th = S.threads[p.thid];
        if (!th) {
            var root = S.posts[p.thid];
            if (!root) {
                return notFound('This thread');
            }
            th = {id: root.id, reply_count: root.reply_count || 0, last_reply_at: root.last_reply_at || 0, last_viewed_at: 0,
                participants: root.participants || [], is_following: false, unread_replies: 0, unread_mentions: 0, team_id: p.tid};
        }
        return json(threadOut(th));
    });
    route('PUT', '/api/v4/users/:uid/teams/:tid/threads/:thid/read/:ts', function (req, p) {
        var th = S.threads[p.thid];
        if (th) {
            th.last_viewed_at = int(p.ts, now());
            th.unread_replies = 0;
            th.unread_mentions = 0;
            emit('thread_read_changed', {thread_id: th.id, timestamp: th.last_viewed_at, unread_mentions: 0, unread_replies: 0, unread_urgent_mentions: 0,
                previous_unread_mentions: 0, previous_unread_replies: 0}, {user_id: S.me.id, team_id: p.tid});
            return json(threadOut(th));
        }
        return ok();
    });
    route('PUT', '/api/v4/users/:uid/teams/:tid/threads/read', function (req, p) {
        values(S.threads).forEach(function (th) {
            if (th.team_id === p.tid) {
                th.unread_replies = 0;
                th.unread_mentions = 0;
                th.last_viewed_at = now();
            }
        });
        emit('thread_read_changed', {timestamp: now()}, {user_id: S.me.id, team_id: p.tid});
        return ok();
    });
    route('POST', '/api/v4/users/:uid/teams/:tid/threads/:thid/set_unread/:pid', function (req, p) {
        var th = S.threads[p.thid];
        var post = S.posts[p.pid];
        if (th && post) {
            th.last_viewed_at = post.create_at - 1;
            th.unread_replies = (S.replies[p.thid] || []).filter(function (id) {
                return S.posts[id].create_at >= post.create_at;
            }).length;
            return json(threadOut(th));
        }
        return ok();
    });
    function follow(p, value) {
        var root = S.posts[p.thid];
        var th = S.threads[p.thid];
        if (!th && root) {
            th = S.threads[p.thid] = {id: root.id, reply_count: root.reply_count || 0, last_reply_at: root.last_reply_at || 0,
                last_viewed_at: now(), participants: root.participants || [], unread_replies: 0, unread_mentions: 0, team_id: p.tid};
        }
        if (th) {
            th.is_following = value;
            emit('thread_follow_changed', {thread_id: th.id, state: value, reply_count: th.reply_count}, {user_id: S.me.id, team_id: p.tid});
        }
        return ok();
    }
    route('PUT', '/api/v4/users/:uid/teams/:tid/threads/:thid/following', function (req, p) {
        return follow(p, true);
    });
    route('DELETE', '/api/v4/users/:uid/teams/:tid/threads/:thid/following', function (req, p) {
        return follow(p, false);
    });

    // --- drafts and scheduled posts --------------------------------------------------------------------------------

    route('GET', '/api/v4/users/:uid/teams/:tid/drafts', function (req, p) {
        return json(S.drafts[p.tid] || []);
    });
    route('POST', '/api/v4/drafts', function (req) {
        var d = Object.assign({}, req.body || {}, {user_id: S.me.id, update_at: now()});
        var c = S.channels[d.channel_id] || {};
        var tid = c.team_id || Object.keys(S.teams)[0];
        S.drafts[tid] = (S.drafts[tid] || []).filter(function (x) {
            return !(x.channel_id === d.channel_id && (x.root_id || '') === (d.root_id || ''));
        }).concat([d]);
        emit('draft_updated', {draft: JSON.stringify(d)}, {user_id: S.me.id});
        return json(d, 201);
    });
    route('DELETE', '/api/v4/users/:uid/channels/:cid/drafts', function (req, p) {
        Object.keys(S.drafts).forEach(function (tid) {
            S.drafts[tid] = (S.drafts[tid] || []).filter(function (x) {
                return !(x.channel_id === p.cid && !x.root_id);
            });
        });
        return ok();
    });
    route('DELETE', '/api/v4/users/:uid/channels/:cid/drafts/:root', function (req, p) {
        Object.keys(S.drafts).forEach(function (tid) {
            S.drafts[tid] = (S.drafts[tid] || []).filter(function (x) {
                return !(x.channel_id === p.cid && x.root_id === p.root);
            });
        });
        return ok();
    });
    route('GET', '/api/v4/posts/scheduled/team/:tid', function (req, p) {
        return json(S.scheduled[p.tid] || {});
    });
    route('POST', '/api/v4/posts/schedule', function (req) {
        var b = Object.assign({}, req.body || {}, {id: newId(), user_id: S.me.id, create_at: now(), update_at: now()});
        var c = S.channels[b.channel_id] || {};
        var tid = c.team_id || Object.keys(S.teams)[0];
        var bucket = S.scheduled[tid] = S.scheduled[tid] || {};
        (bucket[tid] = bucket[tid] || []).push(b);
        emit('scheduled_post_created', {scheduledPost: JSON.stringify(b)}, {user_id: S.me.id});
        return json(b, 201);
    });
    route('DELETE', '/api/v4/posts/schedule/:id', function (req, p) {
        Object.keys(S.scheduled).forEach(function (tid) {
            var bucket = S.scheduled[tid] || {};
            Object.keys(bucket).forEach(function (k) {
                if (Array.isArray(bucket[k])) {
                    bucket[k] = bucket[k].filter(function (x) {
                        return x.id !== p.id;
                    });
                }
            });
        });
        emit('scheduled_post_deleted', {scheduledPost: JSON.stringify({id: p.id})}, {user_id: S.me.id});
        return ok();
    });

    // --- files ---------------------------------------------------------------------------------------------------

    function fileRoute(kind) {
        return function (req, p) {
            var blob = S.blobs['file:' + p.fid];
            if (blob) {
                return {blob: blob};
            }
            var rel = S.media['/api/v4/files/' + p.fid + (kind ? '/' + kind : '')] ||
                S.media['/api/v4/files/' + p.fid + '/preview'] || S.media['/api/v4/files/' + p.fid];
            if (!rel) {
                return notFound('This file');
            }
            var f = S.files[p.fid] || {};
            var res = media(rel);
            if (!kind && req.query.get('download') === '1') {
                res.headers = {'Content-Disposition': 'attachment; filename="' + (f.name || 'file').replace(/"/g, '') + '"'};
            }
            return res;
        };
    }
    route('GET', '/api/v4/files/:fid/thumbnail', fileRoute('thumbnail'));
    route('GET', '/api/v4/files/:fid/preview', fileRoute('preview'));
    route('GET', '/api/v4/files/:fid/info', function (req, p) {
        return S.files[p.fid] ? json(S.files[p.fid]) : notFound('This file');
    });
    route('GET', '/api/v4/files/:fid/link', function () {
        return json({link: ''});
    });
    route('GET', '/api/v4/files/:fid/content', function () {
        return json({});
    });
    route('GET', '/api/v4/files/:fid', fileRoute(''));
    route('POST', '/api/v4/files', function (req) {
        var form = req.body instanceof FormData ? req.body : null;
        if (!form) {
            return json({file_infos: [], client_ids: []}, 201);
        }
        var channelId = form.get('channel_id') || req.query.get('channel_id') || '';
        var clientIds = form.getAll('client_ids');
        var files = form.getAll('files');
        var infos = [];
        return Promise.all(files.map(function (file, i) {
            var id = newId();
            var name = file.name || 'file';
            var ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
            var info = {id: id, user_id: S.me.id, channel_id: channelId, post_id: '', create_at: now(), update_at: now(), delete_at: 0,
                name: name, extension: ext, size: file.size, mime_type: file.type || 'application/octet-stream', width: 0, height: 0,
                has_preview_image: false, mini_preview: null, remote_id: '', archived: false, client_id: clientIds[i] || ''};
            S.blobs['file:' + id] = file;
            S.files[id] = info;
            infos.push(info);
            if (!/^image\//.test(info.mime_type) || typeof createImageBitmap !== 'function') {
                return null;
            }
            return createImageBitmap(file).then(function (bmp) {
                info.width = bmp.width;
                info.height = bmp.height;
                info.has_preview_image = true;
            }).catch(function () {
                return null;
            });
        })).then(function () {
            return json({file_infos: infos, client_ids: clientIds}, 201);
        });
    });

    // --- emoji ---------------------------------------------------------------------------------------------------

    route('GET', '/api/v4/emoji', function (req) {
        var page = int(req.query.get('page'), 0);
        var per = int(req.query.get('per_page'), 60);
        var list = values(S.emoji).sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });
        return json(list.slice(page * per, page * per + per));
    });
    route('POST', '/api/v4/emoji/names', function (req) {
        var names = req.body || [];
        return json(values(S.emoji).filter(function (e) {
            return names.indexOf(e.name) >= 0;
        }));
    });
    route('GET', '/api/v4/emoji/name/:name', function (req, p) {
        var e = values(S.emoji).find(function (x) {
            return x.name === p.name;
        });
        return e ? json(e) : notFound('This emoji');
    });
    route('GET', '/api/v4/emoji/autocomplete', function (req) {
        var term = (req.query.get('name') || '').toLowerCase();
        return json(values(S.emoji).filter(function (e) {
            return e.name.indexOf(term) >= 0;
        }));
    });
    route('POST', '/api/v4/emoji/search', function (req) {
        var term = ((req.body || {}).term || '').toLowerCase();
        return json(values(S.emoji).filter(function (e) {
            return e.name.indexOf(term) >= 0;
        }));
    });
    route('GET', '/api/v4/emoji/:eid/image', function (req, p) {
        var rel = S.media['/api/v4/emoji/' + p.eid + '/image'];
        return rel ? media(rel) : notFound('This emoji');
    });
    route('GET', '/api/v4/emoji/:eid', function (req, p) {
        return S.emoji[p.eid] ? json(S.emoji[p.eid]) : notFound('This emoji');
    });
    route('POST', '/api/v4/emoji', function () {
        return forbidden('Custom emoji can\'t be added in the demo.');
    });

    // --- system, config, roles, plugins --------------------------------------------------------------------------

    route('GET', '/api/v4/system/ping', function () {
        return json({status: 'OK', ActiveSearchBackend: 'database', AndroidLatestVersion: '', AndroidMinVersion: '', IosLatestVersion: '',
            IosMinVersion: '', version: S.serverVersion});
    });
    route('GET', '/api/v4/config/client', function () {
        return json(S.config);
    });
    route('GET', '/api/v4/license/client', function () {
        return json(S.license);
    });
    route('GET', '/api/v4/config', function () {
        return forbidden('The System Console isn\'t part of the demo.');
    });
    route('GET', '/api/v4/roles/name/:name', function (req, p) {
        return S.roles[p.name] ? json(S.roles[p.name]) : notFound('This role');
    });
    route('POST', '/api/v4/roles/names', function (req) {
        return json((req.body || []).map(function (n) {
            return S.roles[n];
        }).filter(Boolean));
    });
    route('GET', '/api/v4/roles/:id', function (req, p) {
        var r = values(S.roles).find(function (x) {
            return x.id === p.id;
        });
        return r ? json(r) : notFound('This role');
    });
    route('GET', '/api/v4/plugins/webapp', function () {
        return json(S.plugins);
    });
    route('GET', '/api/v4/plugins/statuses', function () {
        return json(S.plugins.map(function (m) {
            return {plugin_id: m.id, plugin_path: '', state: 2, name: m.name, description: m.description || '', version: m.version,
                cluster_id: '', is_prepackaged: true};
        }));
    });
    route('GET', '/api/v4/custom_profile_attributes/fields', function () {
        return json(S.core.custom_profile_attributes || []);
    });
    route('GET', '/api/v4/custom_profile_attributes/values', function () {
        return json({});
    });
    route('GET', '/api/v4/users/:uid/custom_profile_attributes', function () {
        return json({});
    });
    route('GET', '/api/v4/system/timezones', function () {
        return json(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC']);
    });
    route('GET', '/api/v4/system/notices/:teamid', function () {
        return json([]);
    });
    route('POST', '/api/v4/system/notices/view', function () {
        return ok();
    });
    route('GET', '/api/v4/system/onboarding/complete', function () {
        return json(true);
    });
    route('POST', '/api/v4/client_perf', function () {
        return ok();
    });
    route('POST', '/api/v4/logs', function () {
        return ok();
    });
    route('POST', '/api/v4/telemetry/*', function () {
        return ok();
    });
    route('POST', '/api/v4/opengraph', function (req) {
        var url = (req.body || {}).url;
        var found = null;
        values(S.posts).some(function (p) {
            ((p.metadata || {}).embeds || []).some(function (e) {
                if (e.url === url && e.data) {
                    found = e.data;
                }
                return found;
            });
            return found;
        });
        return json(found || {type: 'website', url: url});
    });
    route('GET', '/api/v4/image', function (req) {
        var url = req.query.get('url') || '';
        return url.indexOf(location.origin) === 0 ? {file: url} : notFound('This image');
    });

    // --- groups: Antimatter's teams and roles are custom groups -----------------------------------------------------

    function groupList(q) {
        var list = S.groups.slice();
        if (q.get('group_source') && q.get('group_source') !== 'custom') {
            list = [];
        }
        var member = q.get('filter_has_member');
        if (member) {
            list = list.filter(function (g) {
                return (g.member_ids || []).indexOf(member) >= 0;
            });
        }
        if (q.get('include_archived') !== 'true') {
            list = list.filter(function (g) {
                return !g.delete_at;
            });
        }
        var term = (q.get('q') || '').toLowerCase();
        if (term) {
            list = list.filter(function (g) {
                return (g.name || '').toLowerCase().indexOf(term) >= 0 || (g.display_name || '').toLowerCase().indexOf(term) >= 0;
            });
        }
        var page = int(q.get('page'), 0);
        var per = int(q.get('per_page'), 60);
        return list.slice(page * per, page * per + per);
    }
    route('GET', '/api/v4/groups', function (req) {
        return json(groupList(req.query));
    });
    route('POST', '/api/v4/groups/names', function (req) {
        var names = req.body || [];
        return json(S.groups.filter(function (g) {
            return names.indexOf(g.name) >= 0;
        }));
    });
    route('GET', '/api/v4/groups/:gid/team_role', function (req, p) {
        return S.groupTeamRoles[p.gid] ? json(S.groupTeamRoles[p.gid]) : notFound('This role');
    });
    route('GET', '/api/v4/groups/:gid/members', function (req, p) {
        var g = S.groups.find(function (x) {
            return x.id === p.gid;
        });
        var members = g ? (g.member_ids || []).map(user).filter(Boolean) : [];
        return json({members: members, total_member_count: members.length});
    });
    route('GET', '/api/v4/groups/:gid', function (req, p) {
        var g = S.groups.find(function (x) {
            return x.id === p.gid;
        });
        return g ? json(g) : notFound('This group');
    });
    route('GET', '/api/v4/users/:uid/groups', function (req, p) {
        var id = uid(p.uid);
        return json(S.groups.filter(function (g) {
            return (g.member_ids || []).indexOf(id) >= 0;
        }));
    });
    route('GET', '/api/v4/teams/:tid/groups_by_channels', function () {
        return json({groups: {}});
    });
    route('GET', '/api/v4/teams/:tid/groups', function () {
        return json({groups: [], total_group_count: 0});
    });
    route('GET', '/api/v4/channels/:cid/groups', function () {
        return json({groups: [], total_group_count: 0});
    });

    // --- Antimatter's own endpoints ------------------------------------------------------------------------------------

    // Put on top: a message kept at the top of its channel for a while.
    route('GET', '/api/v4/channels/:cid/on_top', function (req, p) {
        var t = now();
        return json((S.onTop[p.cid] || []).filter(function (x) {
            return !x.expires_at || x.expires_at > t;
        }));
    });
    route('PUT', '/api/v4/posts/:pid/on_top', function (req, p) {
        var post = S.posts[p.pid];
        if (!post) {
            return notFound('This message');
        }
        var duration = int((req.body || {}).duration, 0);
        var top = {post_id: post.id, channel_id: post.channel_id, created_by: S.me.id, create_at: now(),
            expires_at: duration > 0 ? now() + duration * (duration < 1e6 ? 1000 : 1) : 0};
        S.onTop[post.channel_id] = (S.onTop[post.channel_id] || []).filter(function (x) {
            return x.post_id !== post.id;
        }).concat([top]);
        emit('post_put_on_top', {on_top: top}, {channel_id: post.channel_id});
        return json(top);
    });
    route('DELETE', '/api/v4/posts/:pid/on_top', function (req, p) {
        var post = S.posts[p.pid];
        if (post) {
            S.onTop[post.channel_id] = (S.onTop[post.channel_id] || []).filter(function (x) {
                return x.post_id !== post.id;
            });
            emit('post_removed_from_top', {channel_id: post.channel_id, post_id: post.id}, {channel_id: post.channel_id});
        }
        return ok();
    });
    // Moving a thread to another channel.
    route('POST', '/api/v4/posts/:pid/move_to_channel', function (req, p) {
        var root = S.posts[p.pid];
        var to = S.channels[(req.body || {}).channel_id];
        if (!root || !to) {
            return notFound('This message');
        }
        var from = root.channel_id;
        [root.id].concat(S.replies[root.id] || []).forEach(function (id) {
            var post = S.posts[id];
            emit('post_deleted', {post: JSON.stringify(Object.assign({}, post, {delete_at: now()}))}, {channel_id: from});
            post.channel_id = to.id;
            post.update_at = now();
        });
        indexPosts();
        emit('posted', {channel_display_name: to.display_name, channel_name: to.name, channel_type: to.type, post: JSON.stringify(root),
            sender_name: '@' + S.me.username, team_id: to.team_id || ''}, {channel_id: to.id});
        return json(root);
    });
    route('POST', '/api/v4/channels/:cid/message_request', function (req, p) {
        var m = S.myMembers[p.cid];
        if (m) {
            m.notify_props = Object.assign({}, m.notify_props, {dm_request: (req.body || {}).action === 'accept' ? 'accepted' : 'dismissed'});
        }
        return json(m || {});
    });
    route('POST', '/api/v4/channels/:cid/export', function (req, p) {
        var rows = [['date', 'user', 'message']].concat(channelPosts(p.cid, false).slice().reverse().map(function (id) {
            var post = S.posts[id];
            return [new Date(post.create_at).toISOString(), (S.users[post.user_id] || {}).username || '', post.message];
        }));
        var csv = rows.map(function (r) {
            return r.map(function (v) {
                return '"' + String(v).replace(/"/g, '""') + '"';
            }).join(',');
        }).join('\n') + '\n';
        return {blob: new Blob([csv], {type: 'text/csv'}), headers: {'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + ((S.channels[p.cid] || {}).name || 'channel') + '.csv"'}};
    });
    route('GET', '/api/v4/posts/:pid/speech', function () {
        return notFound('Reading aloud');
    });
    route('GET', '/api/v4/teams/:tid/timeouts', function (req, p) {
        return replay(req) || json([]);
    });
    route('PUT', '/api/v4/teams/:tid/members/:uid/timeout', function (req, p) {
        var key = 'GET /api/v4/teams/' + p.tid + '/timeouts';
        var list = (S.recorded[key] || []).filter(function (x) {
            return x.user_id !== p.uid;
        });
        var b = req.body || {};
        var entry = null;
        if (b.until) {
            entry = {team_id: p.tid, user_id: p.uid, until: b.until, reason: b.reason || '', created_by: S.me.id, create_at: now()};
            list.push(entry);
        }
        S.recorded[key] = list;
        emit('member_timeouts_updated', {team_id: p.tid}, {team_id: p.tid});
        return entry ? json(entry) : ok();
    });
    route('GET', '/api/v4/channels/:cid/overrides/effective', function (req) {
        return replay(req) || json([]);
    });
    route('GET', '/api/v4/channels/:cid/overrides', function (req) {
        return replay(req) || json([]);
    });
    route('GET', '/api/v4/teams/:tid/server_categories', function (req) {
        return replay(req) || json([]);
    });
    route('GET', '/api/v4/teams/:tid/server_categories/overrides', function (req) {
        return replay(req) || json([]);
    });
    route('GET', '/api/v4/teams/:tid/channels/managed_categories', function (req) {
        return replay(req) || json({});
    });
    route('GET', '/api/v4/teams/:tid/user_attributes/fields', function (req) {
        return replay(req) || json([]);
    });
    route('POST', '/api/v4/teams/:tid/user_attributes/values/search', function (req) {
        var all = (replay({method: 'POST', path: req.path, query: new URLSearchParams()}) || {}).json || {};
        var out = {};
        ((req.body || {}).user_ids || []).forEach(function (id) {
            if (all[id]) {
                out[id] = all[id];
            }
        });
        return json(out);
    });
    route('GET', '/api/v4/teams/:tid/members/:uid/moderation', function (req, p) {
        return replay(req) || json({team_id: p.tid, user_id: p.uid, joined_at: 0, posts_last_day: 0, posts_last_week: 0});
    });
    route('GET', '/api/v4/channels/:cid/role_access', function (req) {
        return replay(req) || json({group_ids: []});
    });
    route('GET', '/api/v4/properties/groups/:group/:target/fields', function (req) {
        return replay(req) || json([]);
    });
    route('GET', '/api/v4/properties/groups/:group/:target/values/:id', function () {
        return json([]);
    });
    // Attribute-based access control: everything the visitor asks for is allowed.
    route('POST', '/api/v4/access_control/decisions/actions/search', function (req) {
        var b = req.body || {};
        var actions = b.actions || [];
        var decisions = {};
        actions.forEach(function (a) {
            decisions[a] = {allowed: true, evaluated: true};
        });
        return json({resource: b.resource || {}, results: actions.map(function (a) {
            return {action: {name: a}};
        }), decisions: decisions});
    });
    route('GET', '/api/v4/agents', function () {
        return json([]);
    });
    route('GET', '/api/v4/content_flagging/team/:tid/status', function () {
        return json({enabled: false});
    });
    ['/api/v4/teams/:tid/patch', '/api/v4/teams/:tid'].forEach(function (path) {
        route('PUT', path, function (req, p) {
            var t = S.teams[p.tid];
            if (!t) {
                return notFound('This team');
            }
            Object.assign(t, req.body || {}, {id: t.id, update_at: now()});
            emit('update_team', {team: JSON.stringify(t)}, {team_id: t.id});
            return json(t);
        });
    });

    // --- the API used by mock/plugins.js and mock/boot.js -------------------------------------------------------------

    var api = {
        route: route,
        emit: emit,
        json: json,
        ok: ok,
        media: media,
        notFound: notFound,
        forbidden: forbidden,
        newId: newId,
        now: now,
        clone: clone,
        values: values,
        int: int,
        state: function () {
            return S;
        },
        createPost: createPost,
        addReaction: addReaction,
        ephemeral: ephemeral,
        currentChannelId: function () {
            return currentChannelId;
        },
        channelMemberIds: channelMemberIds,
    };

    window.DemoServer = {
        api: api,
        load: load,
        handle: handle,
        ready: ready,
        misses: misses,
        userId: function () {
            return S.me ? S.me.id : '';
        },
        connectionId: function () {
            return connectionId;
        },
        serverVersion: function () {
            return S.serverVersion || '';
        },
        // onSocketAction answers an action the app sends on its websocket; its result goes in the reply's data.
        onSocketAction: function (action, data) {
            if (action === 'get_statuses') {
                var all = {};
                values(S.statuses).forEach(function (st) {
                    all[st.user_id] = st.status;
                });
                return all;
            }
            if (action === 'get_statuses_by_ids') {
                var some = {};
                (data.user_ids || []).forEach(function (id) {
                    some[id] = (S.statuses[id] || {}).status || 'offline';
                });
                return some;
            }
            if (action === 'user_typing' && window.DemoLife) {
                window.DemoLife.visitorTyping(data);
            }
            return {};
        },
    };
    window.__demoMisses = misses;
}());
