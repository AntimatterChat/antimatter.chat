// The ambient assistant's mock server (ASSISTANT_API.md, ASSISTANT_DISPLAY.md): its routes under /api/v4/assistant,
// kept in memory per visitor like the rest of the mock. Settings are the assistant switched on everywhere (server-
// and community-wide), engine "rules". A small seeded feed sits in the Lumen Labs #ops-alerts channel; the live
// reaction (afterVisitorPost, called by server.js after a post is created) adds a matching card about 2s after the
// visitor asks about a host's cpu/memory/disk/load, or whether it's down. A card's "result" is the tool's own text:
// JSON with an "attachments" member, the same shape a bot's formatted post uses, so the panel (and "Post to
// channel") render it exactly like a real card.
(function () {
    'use strict';

    var api, S;
    var B = '/api/v4/assistant';

    // The fixtures' own hosts (from the Grafana/Sentry attachments already in #ops-alerts) plus two the assistant
    // talks about that no fixture mentions: www-1 (the CPU walkthrough) and api-2 (the restart offer).
    var HOSTS = ['mqtt-eu-west', 'mqtt-eu-west-2', 'www-1', 'api-2'];

    var METRICS = {
        cpu: {label: 'CPU', unit: '%', lo: 3, hi: 97, threshold: 80},
        memory: {label: 'Memory', unit: '%', lo: 10, hi: 95, threshold: 85},
        disk: {label: 'Disk', unit: '%', lo: 20, hi: 98, threshold: 90},
        load: {label: 'Load average', unit: '', lo: 0, hi: 6, threshold: 4},
    };

    var data = {
        serverEnabled: true,
        engine: 'rules',
        allowCommunityOverride: true,
        on: {}, // channel id -> the person's own switch (default true)
        presence: {}, // channel id -> {open, at}
        cards: {}, // card id -> card
        order: {}, // channel id -> [card ids] (insertion order; the feed sorts by create_at)
        mutedTools: [],
        community: {}, // team id -> {enabled, engine, connection_id, model}
    };

    function b(path) {
        return B + path;
    }

    // --- small helpers -----------------------------------------------------------------------------------------------

    function opsChannel() {
        return api.values(S.channels).find(function (c) {
            return c.name === 'ops-alerts';
        });
    }

    function channelOn(cid) {
        return data.on[cid] !== false;
    }

    function enabledFor(cid) {
        var c = S.channels[cid];
        if (!data.serverEnabled || !c || c.delete_at) {
            return false;
        }
        var cs = data.community[c.team_id];
        return !(cs && cs.enabled === false);
    }

    function following(cid) {
        return enabledFor(cid) && channelOn(cid);
    }

    function errorRes(status, id, message) {
        return {status: status, json: {id: id, message: message, status_code: status, detailed_error: ''}};
    }

    function outCard(c) {
        return api.clone(c);
    }

    function emitUser(name, payload) {
        api.emit(name, payload, {user_id: S.me.id});
    }

    function emitOffer(c) {
        emitUser('assistant_offer_updated', {channel_id: c.channel_id, card_id: c.id, offer: api.clone(c.offer)});
    }

    function touch(c) {
        c.update_at = api.now();
        emitUser('assistant_card_updated', {channel_id: c.channel_id, card: outCard(c)});
    }

    function addCard(fields) {
        var t = api.now();
        var c = Object.assign({
            id: api.newId(), user_id: S.me.id, status: 'new', pinned: false, create_at: t, update_at: t,
            post_ids: [], dedupe_key: api.newId(), arguments: {},
        }, fields);
        data.cards[c.id] = c;
        (data.order[c.channel_id] = data.order[c.channel_id] || []).push(c.id);
        emitUser('assistant_card_added', {channel_id: c.channel_id, card: outCard(c)});
        return c;
    }

    function cardIn(cid, id) {
        var c = data.cards[id];
        return c && c.channel_id === cid ? c : null;
    }

    function withCard(p, fn) {
        var c = cardIn(p.cid, p.id);
        return c ? fn(c) : api.notFound('This card');
    }

    // A tool's result, as ASSISTANT_DISPLAY.md has it: JSON text with "attachments" (the same shape a bot's
    // message-attachment post uses) and a plain "summary" line.
    function resultOf(attachments, summary) {
        return JSON.stringify({attachments: attachments, summary: summary});
    }

    function parseResult(text) {
        if (typeof text !== 'string') {
            return null;
        }
        try {
            var v = JSON.parse(text);
            return v && typeof v === 'object' && Array.isArray(v.attachments) ? v : null;
        } catch (e) {
            return null;
        }
    }

    // --- a small, deterministic fake series from the host's own name, for the live reaction -----------------------

    function hashSeed(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = (h * 31 + s.charCodeAt(i)) >>> 0;
        }
        return h || 1;
    }

    function series(seedStr, n, lo, hi) {
        var seed = hashSeed(seedStr);
        function rand() {
            seed = (seed * 1103515245 + 12345) >>> 0;
            return (seed % 10000) / 10000;
        }
        var mid = lo + (hi - lo) * (0.3 + rand() * 0.3);
        var out = [];
        for (var i = 0; i < n; i++) {
            var arc = Math.sin((i / (n - 1)) * Math.PI); // rises then falls, like a real hour of load
            var v = mid + arc * (hi - mid) * 0.6 + (rand() - 0.5) * (hi - lo) * 0.08;
            out.push(Math.max(lo, Math.min(hi, Math.round(v * 10) / 10)));
        }
        return out;
    }

    function timeAgo(ms) {
        return new Date(api.now() - ms).toTimeString().slice(0, 5);
    }

    function findHost(name) {
        var lower = (name || '').toLowerCase().replace(/[?.!,]+$/, '');
        return HOSTS.find(function (h) {
            return h.toLowerCase() === lower;
        });
    }

    // --- the seeded feed -----------------------------------------------------------------------------------------

    function metricAttachment(host, metric, values) {
        var cfg = METRICS[metric] || METRICS.cpu;
        var now = values[values.length - 1];
        var peak = Math.max.apply(null, values);
        var avg = Math.round((values.reduce(function (a, v) { return a + v; }, 0) / values.length) * 10) / 10;
        var fmt = function (v) { return v + cfg.unit; };
        var fallback = cfg.label + ' on ' + host + ': ' + fmt(now) + ' now, ' + fmt(peak) + ' peak in the last hour';
        return {
            fallback: fallback,
            attachment: {
                fallback: fallback, color: now > cfg.threshold ? '#E8590C' : '#3E8EDE', author_name: 'Grafana',
                title: cfg.label + ' on ' + host + ' (last hour)', title_link: '#',
                text: fmt(now) + ' now · peak ' + fmt(peak) + ' · average ' + fmt(avg),
                fields: [{title: 'Now', value: fmt(now), short: true}, {title: 'Peak', value: fmt(peak), short: true}],
                chart: {values: values, threshold: cfg.threshold, label: cfg.label + (cfg.unit ? ' (' + cfg.unit + ')' : '')},
                footer: 'Grafana · Node overview',
            },
        };
    }

    function metricCard(cid, host, metric, values, postIds, t) {
        var out = metricAttachment(host, metric, values);
        return {
            channel_id: cid, kind: 'insight', tool: 'mcp.grafana.query_prometheus', tool_title: 'Query Prometheus',
            arguments: {host: host, metric: metric}, result: resultOf([out.attachment], out.fallback),
            why: {
                engine: 'rules', pattern: 'ops.resource_usage', words: [metric + ' on ' + host],
                entities: [{type: 'host', value: host, text: host}],
            },
            post_ids: postIds || [], create_at: t, update_at: t,
        };
    }

    function statusCard(cid, host, postIds, t) {
        var up = hashSeed(host + ':status') % 5 !== 0; // "down" one host in five, the same host every time
        var fallback = up ? ('No alerts for ' + host) : ('Firing: ' + host + ' is not responding');
        var attachment = up
            ? {fallback: fallback, color: '#23A55A', author_name: 'Alertmanager', title: fallback, footer: 'Alertmanager'}
            : {
                fallback: fallback, color: '#DA3633', author_name: 'Alertmanager', title: fallback, title_link: '#',
                fields: [{title: 'Severity', value: 'critical', short: true}, {title: 'Target', value: host, short: true},
                    {title: 'Since', value: timeAgo(180000), short: true}],
                footer: 'Alertmanager',
            };
        return {
            channel_id: cid, kind: 'insight', tool: 'mcp.alertmanager.list_alerts', tool_title: 'Alertmanager alerts',
            arguments: {target: host}, result: resultOf([attachment], fallback),
            why: {
                engine: 'rules', pattern: 'ops.alert_status', words: ['is ' + host + ' down'],
                entities: [{type: 'host', value: host, text: host}],
            },
            post_ids: postIds || [], create_at: t, update_at: t,
        };
    }

    function seed() {
        var ops = opsChannel();
        if (!ops) {
            return;
        }
        var t0 = api.now() - 36 * 60000;

        // 1. A Grafana CPU card for a fixture host, with a chart, Now/Peak fields and a link to #.
        addCard(metricCard(ops.id, 'mqtt-eu-west-2', 'cpu', [52, 55, 61, 74, 83, 89, 91, 86, 72, 63, 58, 61], [], t0));

        // 2. An Alertmanager card: a firing alert, severity warning.
        var alertFallback = 'Device reconnects above threshold — mqtt-eu-west';
        addCard({
            channel_id: ops.id, kind: 'insight', tool: 'mcp.alertmanager.list_alerts', tool_title: 'Alertmanager alerts',
            arguments: {target: 'mqtt-eu-west'},
            result: resultOf([{
                fallback: alertFallback, color: '#F2994A', author_name: 'Alertmanager', title: alertFallback, title_link: '#',
                fields: [{title: 'Severity', value: 'warning', short: true}, {title: 'Target', value: 'mqtt-eu-west', short: true},
                    {title: 'Since', value: timeAgo(23 * 60000), short: true}],
                chart: {values: [12, 14, 13, 15, 18, 26, 39, 52, 61, 70, 78, 74], threshold: 50, label: 'Device reconnects/s'},
                footer: 'Alertmanager',
            }], alertFallback),
            why: {
                engine: 'rules', pattern: 'ops.alert_status', words: ['alerts on mqtt-eu-west'],
                entities: [{type: 'host', value: 'mqtt-eu-west', text: 'mqtt-eu-west'}],
            },
            post_ids: [], create_at: t0 + 6 * 60000, update_at: t0 + 6 * 60000,
        });

        // 3. A "No alerts" green card.
        var noneFallback = 'No alerts for lumen-app';
        addCard({
            channel_id: ops.id, kind: 'insight', tool: 'mcp.alertmanager.list_alerts', tool_title: 'Alertmanager alerts',
            arguments: {target: 'lumen-app'},
            result: resultOf([{fallback: noneFallback, color: '#23A55A', author_name: 'Alertmanager', title: noneFallback,
                footer: 'Alertmanager'}], noneFallback),
            why: {
                engine: 'rules', pattern: 'ops.alert_status', words: ['any alerts on lumen-app'],
                entities: [{type: 'service', value: 'lumen-app', text: 'lumen-app'}],
            },
            post_ids: [], create_at: t0 + 11 * 60000, update_at: t0 + 11 * 60000,
        });

        // 4. An action offer, "Restart api-2", offered to nobody yet: Claim, then Run.
        var offerId = api.newId();
        addCard({
            channel_id: ops.id, kind: 'action', tool: 'mcp.ci.restart_service', tool_title: 'Restart service',
            arguments: {service: 'api-2'},
            why: {
                engine: 'rules', pattern: 'ops.action_offer', words: ['restart api-2'],
                entities: [{type: 'service', value: 'api-2', text: 'api-2'}],
            },
            offer_id: offerId,
            offer: {id: offerId, status: 'open', holder_id: '', offered_to_me: false, can_run: false, moves_at: 0},
            post_ids: [], create_at: t0 + 15 * 60000, update_at: t0 + 15 * 60000,
        });
    }

    // --- the live reaction -----------------------------------------------------------------------------------------

    var METRIC_RE = /\b(cpu|memory|disk|load)\b[^?!.\n]*?\bon\s+([a-z0-9][a-z0-9_.-]*)/i;
    var DOWN_RE = /\bis\s+([a-z0-9][a-z0-9_.-]*)\s+down\b/i;

    function afterVisitorPost(post) {
        var ops = opsChannel();
        if (!ops || post.channel_id !== ops.id || !following(ops.id)) {
            return;
        }
        var text = post.message || '';
        var metric, host;
        var m = text.match(METRIC_RE);
        if (m) {
            metric = m[1].toLowerCase();
            host = findHost(m[2]);
        } else {
            var d = text.match(DOWN_RE);
            if (d) {
                metric = 'status';
                host = findHost(d[1]);
            }
        }
        if (!host) {
            return;
        }
        var tool = metric === 'status' ? 'mcp.alertmanager.list_alerts' : 'mcp.grafana.query_prometheus';
        if (data.mutedTools.indexOf(tool) >= 0) {
            return;
        }
        setTimeout(function () {
            var t = api.now();
            if (metric === 'status') {
                addCard(statusCard(ops.id, host, [post.id], t));
            } else {
                addCard(metricCard(ops.id, host, metric, series(host + ':' + metric, 12, METRICS[metric].lo, METRICS[metric].hi),
                    [post.id], t));
            }
        }, 1900 + Math.random() * 300);
    }

    // --- routes --------------------------------------------------------------------------------------------------

    function communitySettingsOut(tid) {
        var s = data.community[tid] || {};
        return {
            team_id: tid, server_enabled: data.serverEnabled, may_override: data.allowCommunityOverride,
            settings: {
                enabled: s.enabled === undefined ? null : s.enabled, engine: s.engine || '',
                connection_id: s.connection_id || '', model: s.model || '',
            },
        };
    }

    function routes() {
        api.route('POST', b('/channels/:cid/presence'), function (req, p) {
            data.presence[p.cid] = {open: Boolean((req.body || {}).open), at: api.now()};
            return api.json({following: following(p.cid), ttl_seconds: 90, heartbeat_seconds: 30});
        });

        api.route('GET', b('/channels/:cid/feed'), function (req, p) {
            var ids = (data.order[p.cid] || []).filter(function (id) {
                return data.cards[id] && data.cards[id].status !== 'dismissed';
            }).sort(function (x, y) {
                return data.cards[x].create_at - data.cards[y].create_at;
            });
            return api.json({
                channel_id: p.cid, enabled: enabledFor(p.cid), on: channelOn(p.cid), engine: data.engine,
                cards: ids.map(function (id) { return outCard(data.cards[id]); }),
            });
        });

        api.route('PUT', b('/channels/:cid/enabled'), function (req, p) {
            var on = Boolean((req.body || {}).on);
            data.on[p.cid] = on;
            if (!on) {
                delete data.presence[p.cid];
            }
            return api.json({on: on});
        });

        api.route('POST', b('/channels/:cid/cards/:id/dismiss'), function (req, p) {
            return withCard(p, function (c) {
                c.status = 'dismissed';
                if (c.offer && c.offer.holder_id === S.me.id && c.offer.status === 'open') {
                    c.offer.holder_id = '';
                    c.offer.offered_to_me = false;
                    c.offer.can_run = false;
                    c.offer.moves_at = 0;
                    emitOffer(c);
                }
                touch(c);
                return api.json(outCard(c));
            });
        });

        api.route('POST', b('/channels/:cid/cards/:id/pin'), function (req, p) {
            return withCard(p, function (c) {
                c.pinned = Boolean((req.body || {}).pinned);
                touch(c);
                return api.json(outCard(c));
            });
        });

        api.route('POST', b('/channels/:cid/cards/:id/mute'), function (req, p) {
            return withCard(p, function (c) {
                if (data.mutedTools.indexOf(c.tool) < 0) {
                    data.mutedTools.push(c.tool);
                }
                c.status = 'dismissed';
                touch(c);
                return api.json(outCard(c));
            });
        });

        api.route('POST', b('/channels/:cid/cards/:id/claim'), function (req, p) {
            return withCard(p, function (c) {
                if (!c.offer) {
                    return api.notFound('This offer');
                }
                if (c.offer.status === 'done') {
                    return errorRes(409, 'app.assistant.offer_done.app_error', 'This was already run.');
                }
                if (c.offer.holder_id === S.me.id) {
                    return api.json(outCard(c));
                }
                if (c.offer.holder_id) {
                    return errorRes(403, 'app.assistant.offer_not_yours.app_error', 'This offer is someone else’s.');
                }
                c.offer.holder_id = S.me.id;
                c.offer.offered_to_me = true;
                c.offer.can_run = true;
                c.offer.moves_at = 0;
                emitOffer(c);
                touch(c);
                return api.json(outCard(c));
            });
        });

        api.route('POST', b('/channels/:cid/cards/:id/run'), function (req, p) {
            return withCard(p, function (c) {
                if (!c.offer) {
                    return api.notFound('This offer');
                }
                if (c.offer.status === 'done') {
                    return errorRes(409, 'app.assistant.offer_done.app_error', 'This was already run.');
                }
                if (c.offer.holder_id !== S.me.id) {
                    return errorRes(403, 'app.assistant.offer_not_yours.app_error', 'This offer is someone else’s.');
                }
                c.offer.status = 'done';
                c.offer.can_run = false;
                c.offer.done_by = S.me.id;
                c.offer.done_at = api.now();
                c.offer.moves_at = 0;
                emitOffer(c);
                touch(c);
                // Stage 1: claimed, closed and audited, but the tool doesn't run yet (the real server doesn't either).
                return api.json({card: outCard(c), executed: false});
            });
        });

        api.route('POST', b('/channels/:cid/cards/:id/post'), function (req, p) {
            return withCard(p, function (c) {
                if (c.kind !== 'insight') {
                    return errorRes(400, 'app.assistant.post_insight_only.app_error', 'Only an insight can be posted.');
                }
                var parsed = parseResult(c.result);
                var message = (parsed && parsed.summary) || c.result || c.tool_title;
                var props = {assistant_card: c.id};
                if (parsed && parsed.attachments && parsed.attachments.length) {
                    props.attachments = parsed.attachments;
                }
                var post = api.createPost({channel_id: p.cid, message: message, props: props});
                c.status = 'posted';
                c.post_ids = (c.post_ids || []).concat([post.id]);
                touch(c);
                return api.json(post, 201);
            });
        });

        api.route('GET', b('/muted_tools'), function () {
            return api.json({tools: data.mutedTools.slice()});
        });
        api.route('PUT', b('/muted_tools'), function (req) {
            data.mutedTools = ((req.body || {}).tools || []).slice(0, 200);
            return api.json({tools: data.mutedTools.slice()});
        });

        api.route('GET', b('/communities/:tid/settings'), function (req, p) {
            return api.json(communitySettingsOut(p.tid));
        });
        api.route('PUT', b('/communities/:tid/settings'), function (req, p) {
            var s = data.community[p.tid] = data.community[p.tid] || {};
            var incoming = (req.body || {}).settings || {};
            ['enabled', 'engine', 'connection_id', 'model'].forEach(function (k) {
                if (incoming[k] === null) {
                    delete s[k];
                } else if (incoming[k] !== undefined && incoming[k] !== '') {
                    s[k] = incoming[k];
                }
            });
            return api.json(communitySettingsOut(p.tid));
        });
    }

    window.DemoAssistant = {
        init: function (serverApi) {
            api = serverApi;
            S = api.state();
            routes();
            seed();
        },
        afterVisitorPost: afterVisitorPost,
    };
}());
