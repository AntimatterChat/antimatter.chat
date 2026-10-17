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
for (const f of ['server.js', 'graphql.js', 'plugins.js']) {
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

(async () => {
    await server.load({base: BASE, version: 'test', locale: '', systemAdmin: false});
    const S = server.api.state();
    const me = S.me.id;
    const team = Object.values(S.teams).find((t) => t.name === 'lumen');
    const community = Object.values(S.teams).find((t) => t.name === 'lumen-community');
    const channel = Object.values(S.channels).find((c) => c.team_id === team.id && c.name === 'firmware');
    const town = Object.values(S.channels).find((c) => c.team_id === team.id && c.name === 'town-square');
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
    await req('POST', '/api/v4/channels/members/me/view', {channel_id: channel.id, collapsed_threads_supported: true}, (r) => r.status === 'OK');
    await req('GET', `/api/v4/channels/${channel.id}/on_top`, undefined, Array.isArray);
    await req('GET', `/api/v4/channels/${dm.id}/posts?page=0&per_page=5&skipFetchThreads=true&collapsedThreads=true&collapsedThreadsExtended=false`,
        undefined, (p) => Array.isArray(p.order));
    await req('GET', '/api/v4/agents', undefined, Array.isArray);
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
    await req('GET', '/plugins/memes/api/v1/templates', undefined, (t) => t.length > 10);
    await req('GET', '/plugins/com.antimatterchat.gifs/api/v1/config', undefined, (c) => c.configured);
    await req('GET', '/plugins/com.antimatterchat.gifs/api/v1/search?kind=gif&q=cats&locale=en', undefined, (p) => p.items.length > 0);
    await req('GET', '/plugins/com.antimatterchat.voice-channels/api/v1/config', undefined, (c) => c.auto_join === false);
    await req('GET', '/plugins/focalboard/api/v2/teams/' + team.id + '/boards', undefined, (b) => b.length > 0);
    const board = Object.values((apps.focalboard || {}).boards || {})[0];
    if (board) {
        const blocks = await req('GET', `/plugins/focalboard/api/v2/boards/${board.id}/blocks?all=true`, undefined, (b) => b.length > 0);
        const card = blocks.find((b) => b.type === 'card');
        await req('PATCH', `/plugins/focalboard/api/v2/boards/${board.id}/blocks/${card.id}`, {updatedFields: {properties: {}}, deletedFields: []});
        if (!sent.some((m) => m.event === 'custom_focalboard_UPDATE_BOARD' && m.data.block && m.data.block.id === card.id)) {
            failures++;
            console.log('FAIL no board update event');
        }
    }
    await req('GET', '/plugins/playbooks/api/v0/settings');
    const gq = await req('POST', '/plugins/playbooks/api/v0/query', {operationName: 'RunsOnTeamQuery',
        variables: {participant: me, teamID: team.id, status: 'InProgress'},
        query: 'query RunsOnTeamQuery($participant: String!, $teamID: String!, $status: String!) { runs(teamID: $teamID, statuses: [$status], participantOrFollowerID: $participant) { edges { node { channel_id: channelID team_id: teamID __typename } __typename } __typename } }'},
    (r) => r.data && r.data.runs && Array.isArray(r.data.runs.edges));
    if (process.env.DEBUG) {
        console.log(JSON.stringify(gq));
    }
    await req('GET', `/plugins/playbooks/api/v0/runs?page=0&per_page=15&sort=last_status_update_at&direction=desc&statuses=InProgress&types=playbook&types=channelChecklist&team_id=${team.id}`,
        undefined, (r) => Array.isArray(r.items));
    await req('GET', '/plugins/com.mattermost.calls/config', undefined, (c) => c.EnableRinging === false);
    await req('GET', `/plugins/com.mattermost.calls/${channel.id}`, undefined, (c) => c.channel_id === channel.id);

    console.log(failures ? `${failures} failures` : 'mock server: all requests answered');
    process.exit(failures ? 1 : 0);
})();
