#!/usr/bin/env node
// A quick check of the demo's mock server without a browser: it loads src/demo/mock/*.js with the fixtures, plays
// the requests the app makes when it starts and when a visitor uses it (from what the app's code does), and fails
// when one is refused, answered by the catch-all, or answered with the wrong shape.
//
//     node tools/demo/smoke_mock.js            (DEBUG=1 to print every answer)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MOCK = path.join(ROOT, 'src', 'demo', 'mock');
const FIXTURES = path.join(ROOT, 'src', 'demo', 'fixtures');
const BASE = '/demo/';

const sent = [];
const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, TextEncoder, Blob,
    Response, FormData, Headers, crypto: globalThis.crypto, Promise, JSON, Math, Date, Intl,
    location: {origin: 'https://antimatter.example', search: '', href: 'https://antimatter.example/demo/', pathname: '/demo/', hostname: 'antimatter.example', host: 'antimatter.example'},
    sessionStorage: {getItem: () => null, setItem: () => null},
    document: {visibilityState: 'visible'},
    addEventListener: () => {},
    fetch: async (url) => {
        const u = new URL(url, 'https://antimatter.example');
        const file = path.join(FIXTURES, decodeURIComponent(u.pathname.slice((BASE + 'fixtures/').length)));
        if (!fs.existsSync(file)) {
            if (u.pathname.endsWith('plugins_webapp.json')) {
                return new Response('[]');
            }
            return new Response('', {status: 404});
        }
        return new Response(fs.readFileSync(file));
    },
};
context.window = context;
context.DemoSocket = {broadcast: (msg) => sent.push(msg), count: () => 1};
vm.createContext(context);
for (const f of ['server.js', 'plugins.js', 'assistant.js']) {
    vm.runInContext(fs.readFileSync(path.join(MOCK, f), 'utf8'), context, {filename: f});
}
const server = context.DemoServer;

let failures = 0;
async function req(method, url, body, check) {
    const before = server.misses.length;
    const msg = {type: 'demo-request', method, url, headers: {'content-type': 'application/json'},
        body: body === undefined ? null : new TextEncoder().encode(JSON.stringify(body)).buffer};
    const res = await server.handle(msg);
    const status = res.status || 200;
    const missed = server.misses.length > before;
    let problem = '';
    if (status >= 400) {
        problem = `status ${status}: ${JSON.stringify(res.json)}`;
    } else if (missed) {
        problem = 'answered by the catch-all';
    } else if (check) {
        try {
            const r = check(res.json, res);
            if (r === false) {
                problem = 'unexpected answer: ' + JSON.stringify(res.json).slice(0, 300);
            }
        } catch (e) {
            problem = 'check failed: ' + e.message + ' ' + JSON.stringify(res.json).slice(0, 300);
        }
    }
    if (problem) {
        failures++;
        console.log(`FAIL ${method} ${url}: ${problem}`);
    } else if (process.env.DEBUG) {
        console.log(`ok   ${method} ${url} ${JSON.stringify(res.json || res.file || res.text || '').slice(0, 160)}`);
    }
    return res.json;
}

// Fusion pages through a channel from the first and last rows of its list, and folds join and leave messages into a
// row whose id ("user-activity-<ids>") no server knows: a page that stops on one of them while more posts lie beyond
// makes Fusion ask for that id again and again, and the list flickers (General, 2026-10-17). Every channel, read the
// way Fusion reads it, in both directions and with small and large pages, must reach its ends and leave nothing out.
const USER_ACTIVITY = new Set(['system_add_to_channel', 'system_join_channel', 'system_leave_channel', 'system_remove_from_channel',
    'system_add_to_team', 'system_join_team', 'system_leave_team', 'system_remove_from_team']);
async function pagesOfEveryChannel(S) {
    const q = 'skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false';
    const problem = (c, what) => {
        failures++;
        console.log(`FAIL paging ${c.name || c.id}: ${what}`);
    };
    let checked = 0;
    for (const c of Object.values(S.channels)) {
        const all = Object.values(S.posts).filter((p) => p.channel_id === c.id && !p.delete_at && !p.root_id)
            .sort((a, b) => b.create_at - a.create_at).map((p) => p.id);
        if (!all.length) {
            continue;
        }
        checked++;
        for (const [first, per] of [[30, 60], [5, 5]]) {
            // Older: the latest page, then before= the oldest post listed until the channel's first post.
            const seen = new Set();
            let page = await req('GET', `/api/v4/channels/${c.id}/posts?page=0&per_page=${first}&${q}`);
            for (let n = 0; page && n < 100; n++) {
                page.order.forEach((id) => seen.add(id));
                if (!page.prev_post_id) {
                    break;
                }
                const oldest = S.posts[page.order[page.order.length - 1]];
                if (USER_ACTIVITY.has(oldest.type)) {
                    problem(c, `a page of older posts ends on a ${oldest.type} message with more before it`);
                    break;
                }
                page = await req('GET', `/api/v4/channels/${c.id}/posts?before=${oldest.id}&page=0&per_page=${per}&${q}`);
            }
            if (seen.size !== all.length) {
                problem(c, `reading back from the latest page gave ${seen.size} of ${all.length} posts`);
            }
            // Newer: after= the newest post listed, from the channel's first post up to the latest.
            const ahead = new Set([all[all.length - 1]]);
            let after = all[all.length - 1];
            for (let n = 0; n < 100; n++) {
                page = await req('GET', `/api/v4/channels/${c.id}/posts?after=${after}&page=0&per_page=${per}&${q}`);
                if (!page || !page.order.length) {
                    break;
                }
                page.order.forEach((id) => ahead.add(id));
                if (!page.next_post_id) {
                    break;
                }
                const newest = S.posts[page.order[0]];
                if (USER_ACTIVITY.has(newest.type)) {
                    problem(c, `a page of newer posts ends on a ${newest.type} message with more after it`);
                    break;
                }
                after = newest.id;
            }
            if (ahead.size !== all.length) {
                problem(c, `reading on from the first post gave ${ahead.size} of ${all.length} posts`);
            }
        }
    }
    if (!checked) {
        problem({name: 'all channels'}, 'no channel has posts');
    }
}

// A call, as the Calls app's client makes it on its own websocket (connection id conn): join, the media
// description answered, unmute, camera, leave. The visitor is alone; the call ends when they leave.
const CALLS = 'custom_com.mattermost.calls_';
function eventsSince(n, name) {
    return sent.slice(n).filter((m) => m.event === name);
}
function expect(what, ok) {
    if (!ok) {
        failures++;
        console.log('FAIL ' + what);
    }
}
async function oneCall(S, channel, me, conn, opts) {
    const n = sent.length;
    server.onSocketAction(CALLS + 'join', {channelID: channel.id, title: '', threadID: ''}, conn);
    const start = eventsSince(n, CALLS + 'call_start')[0];
    expect(`call_start in ${channel.name}`, start && start.data.owner_id === me && start.broadcast.channel_id === channel.id);
    const join = eventsSince(n, CALLS + 'join')[0];
    expect('join for the connection only', join && join.data.connID === conn && join.broadcast.connection_id === conn);
    const joined = eventsSince(n, CALLS + 'user_joined')[0];
    expect('user_joined', joined && joined.data.user_id === me && joined.data.session_id === conn);
    const state = eventsSince(n, CALLS + 'call_state')[0];
    expect('call_state with the visitor alone', state && JSON.parse(state.data.call).sessions.length === 1);
    const post = start && S.posts[start.data.post_id];
    expect(`call post in ${channel.name}`, opts.post ? post && post.type === 'custom_calls' && !post.props.end_at : !start.data.post_id);
    const active = await req('GET', `/plugins/com.mattermost.calls/calls/${channel.id}/active`);
    expect('call active', active && active.active === true);
    const listed = await req('GET', '/plugins/com.mattermost.calls/channels', undefined, Array.isArray);
    const withCall = listed.find((c) => c.channel_id === channel.id);
    expect('the call in the channels list', !withCall || (withCall.call && withCall.call.sessions.length === 1));
    // The client's offer (binary on its socket) gets an answer.
    const before = sent.length;
    server.onSocketBinary(conn, new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 60));
    const signal = eventsSince(before, CALLS + 'signal')[0];
    expect('the offer answered', signal && signal.data.connID === conn && JSON.parse(signal.data.data).type === 'answer');
    for (const [action, event] of [['unmute', 'user_unmuted'], ['video_on', 'user_video_on'], ['video_off', 'user_video_off'],
        ['raise_hand', 'user_raise_hand'], ['mute', 'user_muted']]) {
        const m = sent.length;
        server.onSocketAction(CALLS + action, {}, conn);
        const ev = eventsSince(m, CALLS + event)[0];
        expect(`${action} told as ${event}`, ev && ev.data.session_id === conn && ev.broadcast.channel_id === channel.id);
    }
    const m = sent.length;
    server.onSocketAction(CALLS + 'leave', {}, conn);
    expect('user_left', eventsSince(m, CALLS + 'user_left').length === 1);
    expect('call_end', eventsSince(m, CALLS + 'call_end').length === 1);
    if (opts.post) {
        const ended = S.posts[start.data.post_id];
        expect(`the call post ends (${opts.ended})`, ended.props.end_at > 0 && ended.props.call_status === opts.ended &&
            eventsSince(m, 'post_edited').length === 1);
    }
    const after = await req('GET', `/plugins/com.mattermost.calls/calls/${channel.id}/active`);
    expect('call over', after && after.active === false);
}
async function calls(S, channel, dm, me) {
    await oneCall(S, channel, me, 'conncallschannel000000000a', {post: true, ended: 'ended'});
    await oneCall(S, dm, me, 'conncallsdm00000000000000a', {post: true, ended: 'canceled_by_caller'});
    const voice = (S.apps['com.antimatterchat.voice-channels'].channels || []).map((v) => S.channels[v.channel_id]).find(Boolean);
    if (voice) {
        await oneCall(S, voice, me, 'conncallsvoice0000000000a', {post: false});
    }
    // A channel the visitor isn't in: refused.
    const n = sent.length;
    server.onSocketAction(CALLS + 'join', {channelID: 'notachannel00000000000000x'}, 'conncallsbad0000000000000a');
    expect('joining an unknown channel is refused', eventsSince(n, CALLS + 'error').length === 1 && !eventsSince(n, CALLS + 'call_start').length);
}

// Focus mode: start, the status and custom status it sets, the summary, the end.
async function focus(S, me) {
    await req('GET', '/api/v4/users/me/focus', undefined, (f) => f.active === false);
    const n = sent.length;
    const f = await req('POST', '/api/v4/users/me/focus', {duration: '1h', reason: 'Release notes'},
        (x) => x.active && x.end_at > Date.now() + 55 * 60000 && x.reason === 'Release notes');
    expect('focus: do not disturb', S.statuses[me].status === 'dnd' && eventsSince(n, 'status_change').length >= 1);
    expect('focus: the marker and the custom status', Number(S.me.props.focus_until) === f.end_at &&
        JSON.parse(S.me.props.customStatus).emoji === 'dart');
    await req('POST', '/api/v4/users/me/focus', {duration: 'tomorrow', reason: 'x'}, (x) => x.end_at > Date.now() && new Date(x.end_at).getUTCMinutes() === 0);
    await req('GET', `/api/v4/users/me/focus/summary?since=${f.start_at - 7 * 86400000}&until=${Date.now()}`, undefined,
        (s) => Array.isArray(s.channels) && Array.isArray(s.threads) && typeof s.mention_count === 'number');
    const m = sent.length;
    await req('DELETE', '/api/v4/users/me/focus', undefined, (x) => !x.active && x.ended_at > 0);
    const ended = eventsSince(m, 'focus_ended')[0];
    expect('focus_ended', ended && ended.data.ended_by === 'user' && ended.broadcast.user_id === me);
    expect('focus: status back', S.statuses[me].status !== 'dnd' && !S.me.props.focus_until);
    await req('POST', '/api/v4/users/me/focus/summary/read', {since: 0, until: Date.now()}, (r) => r.status === 'OK');
    const bad = await server.handle({method: 'POST', url: '/api/v4/users/me/focus', headers: {'content-type': 'application/json'},
        body: new TextEncoder().encode(JSON.stringify({duration: 'never'})).buffer});
    expect('focus: a wrong duration is refused', bad.status === 400);
}

// Community rules: as recorded, changed, agreed to.
async function rules(team, community) {
    await req('GET', `/api/v4/teams/${community.id}/rules`, undefined, (r) => r.enabled && r.version >= 1 && r.text && r.must_accept === false);
    await req('GET', `/api/v4/teams/${team.id}/rules`, undefined, (r) => r.team_id === team.id && typeof r.enabled === 'boolean');
    const r = await req('PUT', `/api/v4/teams/${community.id}/rules`, {enabled: true, text: 'Be kind.', ask_again: true}, (x) => x.text === 'Be kind.');
    await req('GET', `/api/v4/teams/${community.id}/rules/stats`, undefined, (s) => s.version === r.version && s.member_count > 0);
    await req('POST', `/api/v4/teams/${community.id}/rules/accept`, {version: r.version}, (x) => x.accepted_version === r.version);
}

async function communityProfiles(community, me) {
    await req('GET', `/api/v4/teams/${community.id}/profiles`, undefined, (r) => Array.isArray(r));
    await req('PATCH', `/api/v4/teams/${community.id}/members/${me}/profile`, {nickname: 'Lighthouse'}, (r) => r.nickname === 'Lighthouse' && r.user_id === me);
    await req('GET', `/api/v4/teams/${community.id}/profiles`, undefined, (r) => r.some((x) => x.user_id === me && x.nickname === 'Lighthouse'));
    await req('POST', `/api/v4/teams/${community.id}/members/${me}/profile/reset`, {nickname: true}, (r) => !r.nickname);
    expect('a community profile change is sent to the community', eventsSince(0, 'community_profile_updated').length >= 2);
}

// The proactive assistant: presence, the seeded feed in #ops-alerts, every card control, the per-channel toggle,
// muted tools, a community's settings, and the live reaction to a visitor's message about a host.
async function assistant(S, me) {
    const team = Object.values(S.teams).find((t) => t.name === 'lumen');
    const community = Object.values(S.teams).find((t) => t.name === 'lumen-community');
    const ops = Object.values(S.channels).find((c) => c.name === 'ops-alerts');
    expect('the demo has an ops-alerts channel', Boolean(ops));
    const A = `/api/v4/assistant/channels/${ops.id}`;

    await req('POST', `${A}/presence`, {open: true}, (r) => r.following === true && r.ttl_seconds === 90 && r.heartbeat_seconds === 30);
    const feed = await req('GET', `${A}/feed`, undefined, (f) => f.enabled && f.on && f.engine === 'rules' && f.cards.length === 4);
    expect('the seeded feed is oldest first', feed.cards[0].create_at <= feed.cards[feed.cards.length - 1].create_at);
    const cpuCard = feed.cards[0];
    expect('the Grafana card has a chart and Now/Peak fields', Array.isArray(JSON.parse(cpuCard.result).attachments[0].chart.values) &&
        JSON.parse(cpuCard.result).attachments[0].fields.some((f) => f.title === 'Now') &&
        JSON.parse(cpuCard.result).attachments[0].fields.some((f) => f.title === 'Peak'));
    const actionCard = feed.cards.find((c) => c.kind === 'action');
    expect('the action starts offered to nobody', actionCard.offer.holder_id === '' && actionCard.offer.can_run === false);
    const alertCard = feed.cards.find((c) => c.kind === 'insight' && c.id !== cpuCard.id && c.tool === 'mcp.alertmanager.list_alerts');
    const noAlertsCard = feed.cards.find((c) => c.tool === 'mcp.alertmanager.list_alerts' && c.id !== alertCard.id);
    expect('a firing alert and a No alerts card are both seeded', Boolean(alertCard) && Boolean(noAlertsCard) &&
        JSON.parse(alertCard.result).attachments[0].fields.some((f) => f.title === 'Severity' && f.value === 'warning') &&
        JSON.parse(noAlertsCard.result).attachments[0].color === '#23A55A');

    // claim, run, dismiss.
    const n = sent.length;
    await req('POST', `${A}/cards/${actionCard.id}/claim`, undefined, (c) => c.offer.holder_id === me && c.offer.can_run === true);
    expect('assistant_offer_updated on claim', eventsSince(n, 'assistant_offer_updated').some((m) => m.data.offer.holder_id === me));
    await req('POST', `${A}/cards/${actionCard.id}/run`, undefined, (r) => r.executed === false && r.card.offer.status === 'done');
    const secondRun = await server.handle({method: 'POST', url: `${A}/cards/${actionCard.id}/run`,
        headers: {'content-type': 'application/json'}, body: null});
    expect('running an action twice is refused', secondRun.status === 409);
    await req('POST', `${A}/cards/${actionCard.id}/dismiss`, undefined, (c) => c.status === 'dismissed');

    // pin, post to channel, mute.
    await req('POST', `${A}/cards/${alertCard.id}/pin`, {pinned: true}, (c) => c.pinned === true);
    const posted = await req('POST', `${A}/cards/${cpuCard.id}/post`, undefined, (p) => p.props.attachments && p.props.attachments[0].chart);
    expect('posting uses the summary as the message', posted.message === JSON.parse(cpuCard.result).summary);
    await req('POST', `${A}/cards/${noAlertsCard.id}/mute`, undefined, (c) => c.status === 'dismissed');
    await req('GET', '/api/v4/assistant/muted_tools', undefined, (m) => m.tools.indexOf(noAlertsCard.tool) >= 0);
    await req('PUT', '/api/v4/assistant/muted_tools', {tools: ['mcp.ci.deploy']}, (m) => m.tools.length === 1 && m.tools[0] === 'mcp.ci.deploy');

    // dismissed/muted cards are gone from the feed; pinned and posted cards stay.
    await req('GET', `${A}/feed`, undefined, (f) => f.cards.length === 2 && f.cards.every((c) => c.id === cpuCard.id || c.id === alertCard.id));

    // the person's own switch for the channel.
    await req('PUT', `${A}/enabled`, {on: false}, (r) => r.on === false);
    await req('GET', `${A}/feed`, undefined, (f) => f.on === false);
    await req('PUT', `${A}/enabled`, {on: true}, (r) => r.on === true);

    // a community's settings (on a different team, so it can't turn the ops-alerts channel off underneath us).
    await req('GET', `/api/v4/assistant/communities/${community.id}/settings`, undefined,
        (s) => s.team_id === community.id && s.server_enabled === true && s.may_override === true && s.settings.enabled === null);
    await req('PUT', `/api/v4/assistant/communities/${community.id}/settings`, {settings: {enabled: false, engine: 'model', connection_id: '', model: ''}},
        (s) => s.settings.enabled === false && s.settings.engine === 'model');
    await req('PUT', `/api/v4/assistant/communities/${community.id}/settings`, {settings: {enabled: null, engine: '', connection_id: '', model: ''}},
        (s) => s.settings.enabled === null);
    expect('community settings do not affect an unrelated team', (await req('GET', `/api/v4/assistant/communities/${team.id}/settings`)).settings.enabled === null);

    // the live reaction: asking about a host in #ops-alerts adds a matching card ~2s later, on the websocket too.
    const before = sent.length;
    await req('POST', '/api/v4/posts', {channel_id: ops.id, message: "what's the cpu on www-1?", root_id: '', pending_post_id: `${me}:live1`, file_ids: [], props: {}});
    await new Promise((r) => setTimeout(r, 2500));
    const live = await req('GET', `${A}/feed`, undefined, (f) => f.cards.some((c) => c.arguments && c.arguments.host === 'www-1'));
    const added = live.cards.find((c) => c.arguments && c.arguments.host === 'www-1');
    expect('the live card is a CPU insight with a chart', added && added.kind === 'insight' &&
        Array.isArray(JSON.parse(added.result).attachments[0].chart.values));
    expect('assistant_card_added was sent for the live card', eventsSince(before, 'assistant_card_added').some((m) => m.data.card.id === added.id));

    // a host not down ("is api-2 down?" and "is www-1 down?" are deterministic from the host's name).
    await req('POST', '/api/v4/posts', {channel_id: ops.id, message: 'is api-2 down?', root_id: '', pending_post_id: `${me}:live2`, file_ids: [], props: {}});
    await new Promise((r) => setTimeout(r, 2500));
    const live2 = await req('GET', `${A}/feed`, undefined, (f) => f.cards.some((c) => c.tool === 'mcp.alertmanager.list_alerts' && c.arguments.target === 'api-2'));

    await req('POST', `${A}/presence`, {open: false}, (r) => typeof r.following === 'boolean');
}

(async () => {
    await server.load({base: BASE, version: 'test', locale: '', systemAdmin: false});
    const S = server.api.state();
    const me = S.me.id;
    const team = Object.values(S.teams).find((t) => t.name === 'lumen');
    const community = Object.values(S.teams).find((t) => t.name === 'lumen-community');
    const channel = Object.values(S.channels).find((c) => c.team_id === team.id && c.name === 'firmware');
    const town = Object.values(S.channels).find((c) => c.team_id === team.id && (c.name === 'general' || c.name === 'town-square'));
    const dm = Object.values(S.channels).find((c) => c.type === 'D');

    // Starting the app (see the Fusion survey in the README).
    await req('GET', '/api/v4/config/client?format=old', undefined, (c) => c.SiteURL.startsWith('https://antimatter.example/demo'));
    await req('GET', '/api/v4/license/client', undefined, (l) => l.IsLicensed === 'true');
    const meOut = await req('GET', '/api/v4/users/me', undefined, (u) => u.id && !/system_admin/.test(u.roles));
    await req('GET', '/api/v4/users/me/preferences', undefined, (p) => p.some((x) => x.name === 'web_ui' && x.value === 'fusion'));
    await req('GET', '/api/v4/users/me/teams', undefined, (t) => t.length === 2);
    await req('GET', '/api/v4/users/me/teams/members', undefined, (t) => t.length === 2);
    await req('GET', '/api/v4/users/me/teams/unread?include_collapsed_threads=true', undefined, (u) => u.length === 2);
    await req('POST', '/api/v4/roles/names', ['system_user', 'team_user', 'team_admin', 'channel_user'], (r) => r.length >= 3 && r[0].permissions);
    await req('GET', '/api/v4/plugins/webapp', undefined, Array.isArray);
    await req('GET', `/api/v4/users/me/teams/${team.id}/channels?include_deleted=false`, undefined, (c) => c.length > 10);
    await req('GET', `/api/v4/users/me/teams/${team.id}/channels/members`, undefined, (c) => c.length > 10);
    await req('GET', '/api/v4/custom_profile_attributes/fields', undefined, Array.isArray);
    await req('GET', '/api/v4/users/me/channels', undefined, (c) => c.length > 20);
    const nd = await server.handle({method: 'GET', url: `/api/v4/users/${me}/channel_members?page=-1&per_page=60`, headers: {}, body: null});
    if (!nd.text || nd.headers['Content-Type'] !== 'application/x-ndjson' || !JSON.parse(nd.text.split('\n')[0]).channel_id) {
        failures++;
        console.log('FAIL channel_members ndjson');
    }
    await req('GET', `/api/v4/groups?filter_allow_reference=false&page=0&per_page=60&include_member_count=true&include_member_ids=true&include_archived=false&filter_has_member=${me}`, undefined, Array.isArray);
    await req('GET', `/api/v4/teams/${team.id}/groups_by_channels?paginate=false&filter_allow_reference=true`, undefined, (g) => g.groups);
    await req('POST', '/api/v4/users/status/ids', [me], (s) => s[0].status === 'online');
    await req('GET', `/api/v4/users/${me}/teams/${team.id}/channels/categories`, undefined, (c) => c.categories.length && c.order.length);
    await req('GET', `/api/v4/teams/${team.id}/channels/managed_categories`);
    await req('GET', `/api/v4/teams/${team.id}/server_categories`, undefined, Array.isArray);
    await req('GET', `/api/v4/teams/${community.id}/timeouts`, undefined, Array.isArray);
    // The default channel by its name, and by its old one (town-square), which apps built before the rename ask for.
    await req('GET', `/api/v4/teams/${team.id}/channels/name/general`, undefined, (c) => c.id === town.id);
    await req('GET', `/api/v4/teams/${team.id}/channels/name/town-square`, undefined, (c) => c.id === town.id);
    await req('GET', '/api/v4/teams/name/lumen/channels/name/town-square', undefined, (c) => c.id === town.id);
    await req('GET', `/api/v4/teams/${community.id}/channels/name/town-square`, undefined, (c) => c.team_id === community.id && c.name === 'general');
    const unknown = await server.handle({method: 'GET', url: `/api/v4/teams/${team.id}/channels/name/no-such-channel`, headers: {}, body: null});
    if (unknown.status !== 404) {
        failures++;
        console.log('FAIL an unknown channel name is not a 404');
    }
    await req('GET', `/api/v4/channels/${channel.id}/overrides/effective`, undefined, Array.isArray);
    await req('GET', '/api/v4/groups?group_source=custom&include_member_ids=true&page=0&per_page=200', undefined, (g) => g.length > 5);
    await req('GET', `/api/v4/users/me/teams/${team.id}/drafts`, undefined, Array.isArray);
    await req('GET', `/api/v4/users/${me}/teams/${team.id}/threads?before=&after=&per_page=25&extended=true&deleted=false&unread=true&since=0&totalsOnly=false&threadsOnly=true`,
        undefined, (t) => Array.isArray(t.threads) && typeof t.total === 'number');
    await req('GET', `/api/v4/system/notices/${team.id}?client=web&clientVersion=1`, undefined, Array.isArray);
    await req('GET', '/api/v4/users?page=0&per_page=100', undefined, (u) => u.length > 20);
    await req('GET', `/api/v4/channels/${channel.id}/members/me`, undefined, (m) => m.channel_id === channel.id);
    await req('GET', `/api/v4/channels/${channel.id}/stats?exclude_files_count=true`, undefined, (s) => s.member_count > 0);
    const posts = await req('GET', `/api/v4/channels/${channel.id}/posts?page=0&per_page=30&skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false`,
        undefined, (p) => p.order.length > 5 && p.posts[p.order[0]] && typeof p.prev_post_id === 'string');
    const oldest = posts.order[posts.order.length - 1];
    await req('GET', `/api/v4/channels/${channel.id}/posts?before=${oldest}&page=0&per_page=60&skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false`,
        undefined, (p) => Array.isArray(p.order));
    await req('GET', `/api/v4/channels/${channel.id}/posts?since=${Date.now() - 1000}&skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false`,
        undefined, (p) => Array.isArray(p.order));
    await pagesOfEveryChannel(S);
    await req('POST', '/api/v4/channels/members/me/view', {channel_id: channel.id, collapsed_threads_supported: true}, (r) => r.status === 'OK');
    await req('GET', `/api/v4/channels/${channel.id}/on_top`, undefined, Array.isArray);
    await req('GET', `/api/v4/channels/${dm.id}/posts?page=0&per_page=5&skipFetchThreads=true&collapsedThreads=true&collapsedThreadsExtended=false`,
        undefined, (p) => Array.isArray(p.order));
    await req('GET', '/api/v4/agents', undefined, Array.isArray);
    await req('GET', `/api/v4/ai/agents?scope=${team.id}`, undefined, (a) => Array.isArray(a) && a.length === 0);
    await req('POST', '/api/v4/ai/agents/activity/ids', [me], (a) => Array.isArray(a));
    await req('GET', `/api/v4/channels/${channel.id}/message_actions`, undefined, (a) => Array.isArray(a));
    await req('POST', `/api/v4/teams/${team.id}/autolinks/preview`,
        {autolinks: {links: [{name: 'Jira', pattern: '(?P<key>LUM-\\d+)', template: '[$key](https://jira.lumenlabs.example/browse/$key)'}]}, text: 'See LUM-12.'},
        (r) => r.text === 'See [LUM-12](https://jira.lumenlabs.example/browse/LUM-12).');
    await req('GET', `/api/v4/users?in_channel=${channel.id}&page=0&per_page=100&sort=`, undefined, (u) => u.length > 1);
    await req('POST', `/api/v4/channels/${channel.id}/members/ids`, [me], (m) => m.length === 1);
    await req('GET', `/api/v4/teams/${team.id}/user_attributes/fields`, undefined, Array.isArray);

    // A thread.
    const root = Object.values(S.posts).find((p) => p.channel_id === channel.id && p.reply_count > 1 && !p.root_id);
    await req('GET', `/api/v4/posts/${root.id}/thread?skipFetchThreads=false&collapsedThreads=true&collapsedThreadsExtended=false&direction=down&perPage=60`,
        undefined, (t) => t.order[0] === root.id && t.order.length === root.reply_count + 1 &&
            S.posts[t.order[1]].create_at <= S.posts[t.order[t.order.length - 1]].create_at);
    await req('GET', `/api/v4/users/${me}/teams/${team.id}/threads/${root.id}?extended=true`, undefined, (t) => t.id === root.id);

    // Images.
    const avatar = await server.handle({method: 'GET', url: `/api/v4/users/${me}/image?_=0`, headers: {}, body: null});
    if (!avatar.file) {
        failures++;
        console.log('FAIL avatar');
    }
    const fileInfo = Object.values(S.files).find((f) => f.has_preview_image);
    if (fileInfo) {
        const preview = await server.handle({method: 'GET', url: `/api/v4/files/${fileInfo.id}/preview`, headers: {}, body: null});
        if (!preview.file) {
            failures++;
            console.log('FAIL file preview');
        }
    }

    // A visitor at work.
    const created = await req('POST', '/api/v4/posts', {channel_id: town.id, message: 'Hello from the demo :tada:', root_id: '', pending_post_id: `${me}:1`, file_ids: [], props: {}},
        (p) => p.id && p.pending_post_id === `${me}:1` && p.user_id === me);
    if (!sent.some((m) => m.event === 'posted' && JSON.parse(m.data.post).id === created.id)) {
        failures++;
        console.log('FAIL no posted event');
    }
    await req('POST', '/api/v4/reactions', {user_id: me, post_id: created.id, emoji_name: 'tada'}, (r) => r.emoji_name === 'tada');
    await req('PUT', `/api/v4/posts/${created.id}/patch`, {id: created.id, message: 'Hello again'}, (p) => p.message === 'Hello again' && p.edit_at > 0);
    await req('DELETE', `/api/v4/users/${me}/posts/${created.id}/reactions/tada`, undefined, (r) => r.status === 'OK');
    await req('POST', '/api/v4/teams/' + team.id + '/posts/search', {terms: 'bootloader', is_or_search: false, page: 0, per_page: 20},
        (r) => r.order.length > 0);
    await req('PUT', `/api/v4/users/${me}/preferences`, [{user_id: me, category: 'flagged_post', name: created.id, value: 'true'}]);
    await req('GET', `/api/v4/users/${me}/posts/flagged?channel_id=&team_id=${team.id}&page=0&per_page=30`, undefined,
        (r) => r.order.indexOf(created.id) >= 0);
    await req('DELETE', `/api/v4/posts/${created.id}`, undefined, (r) => r.status === 'OK');
    await req('GET', '/api/v4/users/autocomplete?in_team=' + team.id + '&in_channel=' + channel.id + '&name=pri&limit=6', undefined,
        (r) => r.users.concat(r.out_of_channel || []).some((u) => u.username === 'priya'));
    await req('POST', '/api/v4/commands/execute', {command: '/poll', channel_id: town.id, team_id: team.id});

    // The apps.
    const apps = S.apps;
    const notes = apps['com.antimatterchat.notes'] || {};
    const noteId = Object.keys(notes.docs || {})[0];
    if (noteId) {
        await req('GET', `/plugins/com.antimatterchat.notes/api/v1/docs/${noteId}`, undefined, (d) => d.id === noteId && d.can_edit);
        await req('GET', `/plugins/com.antimatterchat.notes/api/v1/docs/${noteId}/state`, undefined, (s) => s.snapshot);
        await req('POST', `/plugins/com.antimatterchat.notes/api/v1/docs/${noteId}/updates`, {client_id: '1', data: 'AAA='}, (r) => r.seq === 1);
    }
    const anon = Object.values((apps['com.antimatterchat.polls'] || {}).polls || {}).find((x) => x.anonymous);
    if (anon) {
        await req('GET', `/plugins/com.antimatterchat.polls/api/v1/polls/${anon.id}`, undefined, (p) => p.voter_count > 0);
    }
    const poll = Object.values((apps['com.antimatterchat.polls'] || {}).polls || {}).find((x) => !x.anonymous);
    if (poll) {
        await req('POST', `/plugins/com.antimatterchat.polls/api/v1/polls/${poll.id}/vote`, {option: 0}, (p) => p.my_votes.indexOf(0) >= 0);
    }
    await req('GET', '/plugins/com.mattermost.plugin-todo/lists', undefined, (l) => Array.isArray(l.my));
    await req('GET', `/plugins/com.mattermost.plugin-todo/api/v1/channels/${channel.id}/todos`, undefined, (l) => Array.isArray(l.todos));
    // Todo 0.9's lists: the side panel's tabs, a channel's lists, adding and ticking a todo, favourites, the targets.
    const T = '/plugins/com.mattermost.plugin-todo/api/v1';
    const mine = await req('GET', `${T}/lists?scope=mine`, undefined, (l) => Array.isArray(l) && l.length > 0 && l.every((x) => x.id && typeof x.open_count === 'number'));
    await req('GET', `${T}/lists?scope=favorites`, undefined, (l) => Array.isArray(l));
    const fwLists = await req('GET', `${T}/lists?scope=channel&channel_id=${channel.id}`, undefined, (l) => Array.isArray(l) && l.length > 0 && l.every((x) => x.channel_id === channel.id));
    const fwList = await req('GET', `${T}/lists/${fwLists[0].id}`, undefined, (l) => Array.isArray(l.items) && l.items.some((x) => x.due));
    const added = await req('POST', `${T}/lists/${fwList.id}/items`, {message: 'Smoke todo', due: '2026-12-01'}, (x) => x.id && x.due === '2026-12-01');
    await req('PATCH', `${T}/lists/${fwList.id}/items/${added.id}`, {done: true}, (x) => x.done_at > 0);
    await req('PUT', `${T}/lists/${mine[0].id}/favorite`);
    await req('GET', `${T}/lists?scope=favorites`, undefined, (l) => l.some((x) => x.id === mine[0].id && x.favorite));
    const made = await req('POST', `${T}/lists`, {name: 'Smoke list', icon: '', channel_id: ''}, (l) => l.id && l.name === 'Smoke list' && Array.isArray(l.items));
    await req('DELETE', `${T}/lists/${made.id}`);
    await req('GET', `${T}/targets?channel_id=${channel.id}`, undefined, (t) => Array.isArray(t.lists) && t.default_id);
    await req('GET', '/plugins/memes/api/v1/templates', undefined, (t) => t.length > 10);
    await req('GET', '/plugins/com.antimatterchat.gifs/api/v1/config', undefined, (c) => c.configured);
    await req('GET', '/plugins/com.antimatterchat.gifs/api/v1/search?kind=gif&q=cats&locale=en', undefined, (p) => p.items.length > 0);
    await req('GET', '/plugins/com.antimatterchat.voice-channels/api/v1/config', undefined, (c) => c.auto_join === false);
    await req('GET', '/plugins/com.mattermost.calls/config', undefined, (c) => c.EnableRinging === false);
    await req('GET', `/plugins/com.mattermost.calls/${channel.id}`, undefined, (c) => c.channel_id === channel.id);
    // Playbooks and Kanban are not part of the demo.
    const listed = await req('GET', '/api/v4/plugins/statuses', undefined, Array.isArray);
    if (listed.some((p) => p.plugin_id === 'playbooks' || p.plugin_id === 'focalboard') || apps.playbooks || apps.focalboard) {
        failures++;
        console.log('FAIL Playbooks or Kanban still in the demo');
    }
    await calls(S, channel, dm, me);
    await focus(S, me);
    await rules(team, community);
    await communityProfiles(community, me);
    await assistant(S, me);

    console.log(failures ? `${failures} failures` : 'mock server: all requests answered');
    process.exit(failures ? 1 : 0);
})();
