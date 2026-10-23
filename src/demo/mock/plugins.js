// The default apps' routes in the demo (/plugins/<id>/...), answered from fixtures/apps.json, which
// tools/demo/record_fixtures.py records from each app's own API. What the visitor does in an app (editing a note,
// drawing, voting, ticking a todo, joining a call) is kept in memory like the rest, and the
// events the real apps would get from the server are sent on the fake websocket.
(function () {
    'use strict';

    var api;
    var A; // apps.json
    var S; // the server's state

    var NOTES = 'com.antimatterchat.notes';
    var WHITEBOARD = 'com.antimatterchat.whiteboard';
    var POLLS = 'com.antimatterchat.polls';
    var TODO = 'com.mattermost.plugin-todo';
    var MEMES = 'memes';
    var GIFS = 'com.antimatterchat.gifs';
    var VOICE = 'com.antimatterchat.voice-channels';
    var CALLS = 'com.mattermost.calls';

    function app(id) {
        A[id] = A[id] || {};
        return A[id];
    }

    function event(pid, name, data, broadcast) {
        api.emit('custom_' + pid + '_' + name, data, broadcast);
    }

    function pluginError(status, message) {
        return {status: status, json: {error: message, message: message}};
    }

    // --- Notes and Whiteboard: documents synced with numbered updates ("relay") --------------------------------------

    function relay(pid, defaultTitle, isBoard) {
        var data = app(pid);
        data.docs = data.docs || {};
        data.channels = data.channels || {};
        data.personal = data.personal || [];
        data.favorites = data.favorites || [];
        data.states = data.states || {};
        data.files = data.files || {};
        var thumbnails = {};
        var b = '/plugins/' + pid + '/api/v1';

        function state(id) {
            var st = data.states[id] = data.states[id] || {snapshot: null, snapshot_seq: 0, updates: [], last_seq: 0};
            st.updates = st.updates || [];
            return st;
        }
        function doc(id) {
            var d = data.docs[id];
            if (d) {
                d.can_edit = true;
                d.can_delete = true;
                d.favorite = data.favorites.indexOf(id) >= 0 || undefined;
            }
            return d;
        }
        function list(ids) {
            return (ids || []).map(doc).filter(Boolean).sort(function (x, y) {
                return y.update_at - x.update_at;
            });
        }
        function changed(name, d) {
            var broadcast = d.channel_id ? {channel_id: d.channel_id} : {user_id: S.me.id};
            event(pid, name, {doc_id: d.id, doc: JSON.stringify(d)}, broadcast);
        }

        api.route('GET', b + '/docs', function (req) {
            var cid = req.query.get('channel_id');
            return api.json(cid ? list(data.channels[cid]) : list(data.personal));
        });
        api.route('GET', b + '/favorites', function () {
            return api.json(list(data.favorites));
        });
        api.route('POST', b + '/docs', function (req) {
            var body = req.body || {};
            var t = api.now();
            var d = {id: api.newId(), title: body.title || defaultTitle, channel_id: body.channel_id || undefined,
                owner_id: body.channel_id ? undefined : S.me.id, creator_id: S.me.id, create_at: t, update_at: t, updated_by: S.me.id,
                can_edit: true, can_delete: true};
            data.docs[d.id] = d;
            if (d.channel_id) {
                (data.channels[d.channel_id] = data.channels[d.channel_id] || []).unshift(d.id);
            } else {
                data.personal.unshift(d.id);
            }
            var st = state(d.id);
            if (body.content) {
                st.snapshot = body.content;
            }
            changed('doc_created', d);
            return api.json(d, 201);
        });
        api.route('GET', b + '/docs/:id', function (req, p) {
            var d = doc(p.id);
            return d ? api.json(d) : pluginError(404, 'not found');
        });
        api.route('PATCH', b + '/docs/:id', function (req, p) {
            var d = doc(p.id);
            if (!d) {
                return pluginError(404, 'not found');
            }
            if ((req.body || {}).title !== undefined) {
                d.title = req.body.title || defaultTitle;
            }
            d.update_at = api.now();
            d.updated_by = S.me.id;
            if (d.shared_post_id && S.posts[d.shared_post_id]) {
                var post = S.posts[d.shared_post_id];
                post.props = Object.assign({}, post.props, {title: d.title});
                post.update_at = api.now();
                api.emit('post_edited', {post: JSON.stringify(post)}, {channel_id: post.channel_id});
            }
            changed('doc_updated', d);
            return api.json(d);
        });
        api.route('DELETE', b + '/docs/:id', function (req, p) {
            var d = doc(p.id);
            if (d) {
                delete data.docs[p.id];
                Object.keys(data.channels).forEach(function (cid) {
                    data.channels[cid] = data.channels[cid].filter(function (x) {
                        return x !== p.id;
                    });
                });
                data.personal = data.personal.filter(function (x) {
                    return x !== p.id;
                });
                changed('doc_deleted', d);
            }
            return api.ok();
        });
        api.route('POST', b + '/docs/:id/move', function (req, p) {
            var d = doc(p.id);
            if (!d) {
                return pluginError(404, 'not found');
            }
            var to = (req.body || {}).channel_id || '';
            Object.keys(data.channels).forEach(function (cid) {
                data.channels[cid] = data.channels[cid].filter(function (x) {
                    return x !== p.id;
                });
            });
            data.personal = data.personal.filter(function (x) {
                return x !== p.id;
            });
            if (to) {
                (data.channels[to] = data.channels[to] || []).unshift(d.id);
                d.channel_id = to;
                delete d.owner_id;
            } else {
                data.personal.unshift(d.id);
                delete d.channel_id;
                d.owner_id = S.me.id;
            }
            d.update_at = api.now();
            changed('doc_updated', d);
            return api.json(d);
        });
        api.route('PUT', b + '/docs/:id/favorite', function (req, p) {
            if (data.favorites.indexOf(p.id) < 0) {
                data.favorites.unshift(p.id);
            }
            return api.ok();
        });
        api.route('DELETE', b + '/docs/:id/favorite', function (req, p) {
            data.favorites = data.favorites.filter(function (x) {
                return x !== p.id;
            });
            return api.ok();
        });
        api.route('POST', b + '/docs/:id/share', function (req, p) {
            var d = doc(p.id);
            if (!d || !d.channel_id) {
                return pluginError(400, 'not a channel document');
            }
            var post = api.createPost({channel_id: d.channel_id, type: isBoard ? 'custom_am_whiteboard' : 'custom_antimatter_note',
                message: (isBoard ? 'Shared a whiteboard: **' : 'Shared a note: **') + d.title + '**',
                props: {doc_id: d.id, title: d.title, from_plugin: 'true'}});
            d.shared_post_id = post.id;
            return api.json(post, 201);
        });
        api.route('GET', b + '/docs/:id/state', function (req, p) {
            if (!data.docs[p.id]) {
                return pluginError(404, 'not found');
            }
            return api.json(api.clone(state(p.id)));
        });
        api.route('GET', b + '/docs/:id/updates', function (req, p) {
            var after = api.int(req.query.get('after'), 0);
            var st = state(p.id);
            return api.json({updates: st.updates.filter(function (u) {
                return u.seq > after;
            }), reset: after < (st.snapshot_seq || 0)});
        });
        api.route('POST', b + '/docs/:id/updates', function (req, p) {
            var d = doc(p.id);
            if (!d) {
                return pluginError(404, 'not found');
            }
            var st = state(p.id);
            st.last_seq = (st.last_seq || 0) + 1;
            st.updates.push({seq: st.last_seq, data: (req.body || {}).data});
            d.update_at = api.now();
            d.updated_by = S.me.id;
            // The documents of the demo stay small: no compaction is asked for.
            return api.json({seq: st.last_seq, compact: false});
        });
        api.route('PUT', b + '/docs/:id/snapshot', function (req, p) {
            var st = state(p.id);
            var body = req.body || {};
            st.snapshot = body.data;
            st.snapshot_seq = body.seq || st.last_seq;
            st.updates = st.updates.filter(function (u) {
                return u.seq > st.snapshot_seq;
            });
            return api.ok();
        });
        api.route('POST', b + '/docs/:id/awareness', function () {
            return api.ok();
        });
        api.route('GET', b + '/docs/:id/versions', function () {
            return api.json([]);
        });
        api.route('GET', b + '/docs/:id/versions/:seq', function () {
            return pluginError(404, 'no version');
        });
        if (isBoard) {
            api.route('GET', b + '/docs/:id/files/:fid', function (req, p) {
                var f = data.files[p.id + '/' + p.fid];
                return f ? api.json(f) : pluginError(404, 'not found');
            });
            api.route('PUT', b + '/docs/:id/files/:fid', function (req, p) {
                data.files[p.id + '/' + p.fid] = req.body || {};
                return api.ok();
            });
            api.route('GET', b + '/docs/:id/thumbnail', function (req, p) {
                if (thumbnails[p.id]) {
                    return {blob: thumbnails[p.id]};
                }
                var rel = S.media[b + '/docs/' + p.id + '/thumbnail'];
                return rel ? api.media(rel) : pluginError(404, 'no thumbnail');
            });
            api.route('PUT', b + '/docs/:id/thumbnail', function (req, p) {
                if (req.body instanceof Blob) {
                    thumbnails[p.id] = req.body;
                }
                return api.ok();
            });
            api.route('GET', b + '/libraries', function (req) {
                return api.json(Object.assign({team_id: req.query.get('team_id') || '', can_manage_team: false, can_manage_server: false, libraries: []},
                    data.libraries || {}, {can_manage_team: false, can_manage_server: false}));
            });
            api.route('GET', b + '/libraries/:lid/items', function () {
                return api.json({libraryItems: []});
            });
            api.route('POST', b + '/libraries', function () {
                return pluginError(403, 'Libraries can\'t be added in the demo.');
            });
        }
    }

    // --- Polls -------------------------------------------------------------------------------------------------------

    function polls() {
        var data = app(POLLS);
        data.polls = data.polls || {};
        var b = '/plugins/' + POLLS + '/api/v1';
        // An anonymous poll doesn't say who voted: its recorded count of voters is kept as it is.
        api.values(data.polls).forEach(function (poll) {
            if (poll.anonymous) {
                poll.voter_count_base = poll.voter_count || 0;
            }
        });

        function out(poll) {
            poll.voter_count = 0;
            var voters = {};
            poll.my_votes = [];
            poll.options.forEach(function (o, i) {
                (o.voters || []).forEach(function (v) {
                    voters[v] = true;
                    if (v === S.me.id) {
                        poll.my_votes.push(i);
                    }
                });
                if (poll.anonymous && poll._mine && poll._mine.indexOf(i) >= 0 && poll.my_votes.indexOf(i) < 0) {
                    poll.my_votes.push(i);
                }
            });
            poll.voter_count = poll.anonymous ? Math.max(poll.voter_count_base || 0, Object.keys(voters).length) : Object.keys(voters).length;
            var copy = api.clone(poll);
            delete copy._mine;
            if (copy.anonymous) {
                copy.options.forEach(function (o) {
                    delete o.voters;
                });
            }
            return copy;
        }
        function updated(poll) {
            var o = out(poll);
            event(POLLS, 'poll_updated', {poll: JSON.stringify(o)}, {channel_id: poll.channel_id});
            return api.json(o);
        }
        api.route('GET', b + '/polls/:id', function (req, p) {
            var poll = data.polls[p.id];
            return poll ? api.json(out(poll)) : pluginError(404, 'not found');
        });
        api.route('POST', b + '/polls/:id/vote', function (req, p) {
            var poll = data.polls[p.id];
            var i = (req.body || {}).option;
            if (!poll || poll.closed || !poll.options[i]) {
                return pluginError(400, 'can\'t vote');
            }
            if (!poll.multi) {
                poll.options.forEach(function (o, j) {
                    if (j !== i && (o.voters || []).indexOf(S.me.id) >= 0) {
                        o.voters = o.voters.filter(function (v) {
                            return v !== S.me.id;
                        });
                        o.votes = Math.max(0, o.votes - 1);
                    }
                });
                if (poll.anonymous) {
                    (poll._mine || []).forEach(function (j) {
                        if (j !== i) {
                            poll.options[j].votes = Math.max(0, poll.options[j].votes - 1);
                        }
                    });
                    poll._mine = [];
                }
            }
            var opt = poll.options[i];
            opt.voters = opt.voters || [];
            if (opt.voters.indexOf(S.me.id) < 0 && (poll._mine || []).indexOf(i) < 0) {
                opt.votes = (opt.votes || 0) + 1;
                if (poll.anonymous) {
                    poll.voter_count_base = (poll.voter_count || 0) + ((poll._mine || []).length ? 0 : 1);
                    poll._mine = (poll._mine || []).concat([i]);
                } else {
                    opt.voters.push(S.me.id);
                }
            }
            return updated(poll);
        });
        api.route('POST', b + '/polls/:id/unvote', function (req, p) {
            var poll = data.polls[p.id];
            var i = (req.body || {}).option;
            if (!poll || !poll.options[i]) {
                return pluginError(400, 'can\'t unvote');
            }
            var opt = poll.options[i];
            if ((opt.voters || []).indexOf(S.me.id) >= 0) {
                opt.voters = opt.voters.filter(function (v) {
                    return v !== S.me.id;
                });
                opt.votes = Math.max(0, opt.votes - 1);
            } else if ((poll._mine || []).indexOf(i) >= 0) {
                poll._mine = poll._mine.filter(function (j) {
                    return j !== i;
                });
                opt.votes = Math.max(0, opt.votes - 1);
            }
            return updated(poll);
        });
        api.route('POST', b + '/polls/:id/close', function (req, p) {
            var poll = data.polls[p.id];
            if (!poll) {
                return pluginError(404, 'not found');
            }
            poll.closed = true;
            poll.closed_at = api.now();
            return updated(poll);
        });
        api.route('POST', b + '/polls', function (req) {
            var body = req.body || {};
            var t = api.now();
            var poll = {id: api.newId(), post_id: '', channel_id: body.channel_id, creator_id: S.me.id, question: body.question || '',
                options: (body.options || []).map(function (text) {
                    return {text: text, votes: 0, voters: []};
                }), multi: Boolean(body.multi), anonymous: Boolean(body.anonymous), create_at: t,
                end_at: body.duration_minutes ? t + body.duration_minutes * 60000 : undefined, closed: false, voter_count: 0, my_votes: []};
            data.polls[poll.id] = poll;
            var message = '**Poll:** ' + poll.question + '\n' + poll.options.map(function (o, i) {
                return (i + 1) + '. ' + o.text;
            }).join('\n');
            var post = api.createPost({channel_id: poll.channel_id, root_id: body.root_id || '', type: 'custom_poll', message: message,
                props: {poll_id: poll.id, from_plugin: 'true'}});
            poll.post_id = post ? post.id : '';
            return api.json(out(poll), 201);
        });
    }

    // --- Todo ------------------------------------------------------------------------------------------------------

    function todo() {
        var data = app(TODO);
        data.lists = data.lists || {my: [], in: [], out: []};
        ['my', 'in', 'out'].forEach(function (k) {
            data.lists[k] = data.lists[k] || [];
        });
        data.channels = data.channels || {};
        data.assigned = data.assigned || [];
        data.following = data.following || [];
        var b = '/plugins/' + TODO;

        function refresh() {
            event(TODO, 'refresh', {lists: JSON.stringify(data.lists)}, {user_id: S.me.id});
        }
        function find(id) {
            var found = null;
            ['my', 'in', 'out'].some(function (k) {
                var i = data.lists[k].findIndex(function (x) {
                    return x.id === id;
                });
                if (i >= 0) {
                    found = {list: k, index: i, issue: data.lists[k][i]};
                }
                return found;
            });
            return found;
        }
        function personal(fn) {
            return function (req) {
                fn(req.body || {});
                refresh();
                return {text: '', status: 200};
            };
        }
        function channelList(cid) {
            var c = data.channels[cid] = data.channels[cid] || {can_edit: true, can_manage: true, todos: [], following: false};
            c.can_edit = true;
            c.can_manage = true;
            return c;
        }
        function channelRefresh(cid) {
            event(TODO, 'channel_refresh', {channel_id: cid}, {channel_id: cid});
        }

        api.route('GET', b + '/lists', function () {
            return api.json(data.lists);
        });
        api.route('POST', b + '/add', personal(function (body) {
            var t = api.now();
            var issue = {id: api.newId(), message: body.message || '', description: body.description || '', postPermalink: body.postPermalink || '',
                create_at: t, post_id: body.post_id || '', user: '', list: '', position: 0};
            if (body.send_to && body.send_to !== S.me.username) {
                issue.user = body.send_to;
                issue.list = 'out';
                data.lists.out.unshift(issue);
            } else {
                data.lists.my.unshift(issue);
            }
        }));
        ['complete', 'remove'].forEach(function (action) {
            api.route('POST', b + '/' + action, personal(function (body) {
                var f = find(body.id);
                if (f) {
                    data.lists[f.list].splice(f.index, 1);
                }
            }));
        });
        api.route('POST', b + '/accept', personal(function (body) {
            var f = find(body.id);
            if (f && f.list === 'in') {
                data.lists.in.splice(f.index, 1);
                data.lists.my.unshift(f.issue);
            }
        }));
        api.route('POST', b + '/bump', personal(function () {
            return null;
        }));
        api.route('PUT', b + '/edit', personal(function (body) {
            var f = find(body.id);
            if (f) {
                f.issue.message = body.message;
                f.issue.description = body.description;
            }
        }));
        api.route('POST', b + '/change_assignment', personal(function (body) {
            var f = find(body.id);
            if (f) {
                data.lists[f.list].splice(f.index, 1);
                f.issue.user = body.send_to;
                data.lists.out.unshift(f.issue);
            }
        }));
        api.route('GET', b + '/api/v1/assigned', function () {
            return api.json(data.assigned);
        });
        api.route('GET', b + '/api/v1/following', function () {
            return api.json(data.following);
        });
        api.route('GET', b + '/api/v1/channels/:cid/todos', function (req, p) {
            return api.json(channelList(p.cid));
        });
        api.route('POST', b + '/api/v1/channels/:cid/todos', function (req, p) {
            var body = req.body || {};
            var t = api.now();
            var item = {id: api.newId(), channel_id: p.cid, message: body.message || '', description: body.description || '', creator_id: S.me.id,
                create_at: t, update_at: t, assignee_id: body.assignee_id || '', post_id: body.post_id || ''};
            channelList(p.cid).todos.push(item);
            channelRefresh(p.cid);
            return api.json(item, 201);
        });
        api.route('PATCH', b + '/api/v1/channels/:cid/todos/:id', function (req, p) {
            var list = channelList(p.cid);
            var item = list.todos.find(function (x) {
                return x.id === p.id;
            });
            if (!item) {
                return pluginError(404, 'not found');
            }
            var body = req.body || {};
            ['message', 'description', 'assignee_id', 'post_id'].forEach(function (k) {
                if (body[k] !== undefined) {
                    item[k] = body[k];
                }
            });
            if (body.done === true) {
                item.done_by = S.me.id;
                item.done_at = api.now();
            } else if (body.done === false) {
                delete item.done_by;
                delete item.done_at;
            }
            if (typeof body.position === 'number') {
                list.todos.splice(list.todos.indexOf(item), 1);
                list.todos.splice(Math.max(0, Math.min(body.position, list.todos.length)), 0, item);
            }
            item.update_at = api.now();
            channelRefresh(p.cid);
            return api.json(item);
        });
        api.route('DELETE', b + '/api/v1/channels/:cid/todos/:id', function (req, p) {
            var list = channelList(p.cid);
            list.todos = list.todos.filter(function (x) {
                return x.id !== p.id;
            });
            channelRefresh(p.cid);
            return api.ok();
        });
        // Todo 0.9: lists of todos, personal or a channel's (recorded as todo_lists, with their todos).
        data.todo_lists = data.todo_lists || [];
        data.favorites = data.favorites || [];
        function findList(id) {
            return data.todo_lists.find(function (l) {
                return l.id === id;
            });
        }
        function isOpen(item) {
            return !item.done_at;
        }
        function info(l) {
            var out = {};
            Object.keys(l).forEach(function (k) {
                if (k !== 'items') {
                    out[k] = l[k];
                }
            });
            var open = (l.items || []).filter(isOpen);
            out.open_count = open.length;
            var dues = open.map(function (x) {
                return x.due;
            }).filter(Boolean).sort();
            if (dues.length) {
                out.earliest_due = dues[0];
            } else {
                delete out.earliest_due;
            }
            out.favorite = data.favorites.indexOf(l.id) >= 0;
            out.can_edit = true;
            out.can_rename = true;
            out.can_delete = !l.default;
            out.can_manage = true;
            return out;
        }
        function detail(l) {
            var out = info(l);
            var items = l.items || [];
            out.items = items.filter(isOpen).concat(items.filter(function (x) {
                return !isOpen(x);
            }).sort(function (x, y) {
                return (y.done_at || 0) - (x.done_at || 0);
            }));
            return out;
        }
        function listChanged(l) {
            event(TODO, 'list_changed', {list_id: l.id, channel_id: l.channel_id || ''}, l.channel_id ? {channel_id: l.channel_id} : {user_id: S.me.id});
        }
        function listOr404(p, fn) {
            var l = findList(p.list);
            return l ? fn(l) : pluginError(404, 'list not found');
        }
        function channelInfo(cid) {
            var c = S.channels[cid] || {};
            var team = S.teams[c.team_id] || {};
            if (c.type === 'D' || c.type === 'G') {
                return {scope: 'conversation', channel_name: c.display_name || '', channel_url_name: c.name || ''};
            }
            return {scope: 'channel', channel_name: c.display_name || '', channel_url_name: c.name || '', team_name: team.name || ''};
        }
        api.route('GET', b + '/api/v1/lists', function (req) {
            var scope = req.query.get('scope') || 'mine';
            var cid = req.query.get('channel_id');
            var lists = data.todo_lists.filter(function (l) {
                if (l.archived_at) {
                    return false;
                }
                if (scope === 'favorites') {
                    return data.favorites.indexOf(l.id) >= 0;
                }
                if (scope === 'channel') {
                    return Boolean(cid) && l.channel_id === cid;
                }
                return !l.channel_id;
            });
            return api.json(lists.map(info));
        });
        api.route('POST', b + '/api/v1/lists', function (req) {
            var body = req.body || {};
            var t = api.now();
            var l = {id: api.newId(), name: (body.name || '').trim() || 'Todos', icon: body.icon || '', owner_id: S.me.id, create_at: t, update_at: t, items: []};
            if (body.channel_id) {
                l.channel_id = body.channel_id;
                Object.assign(l, channelInfo(body.channel_id));
            } else {
                l.scope = 'personal';
            }
            data.todo_lists.push(l);
            listChanged(l);
            return api.json(detail(l), 201);
        });
        api.route('GET', b + '/api/v1/lists/:list', function (req, p) {
            return listOr404(p, function (l) {
                return api.json(detail(l));
            });
        });
        api.route('PATCH', b + '/api/v1/lists/:list', function (req, p) {
            return listOr404(p, function (l) {
                var body = req.body || {};
                if (typeof body.name === 'string' && body.name.trim()) {
                    l.name = body.name.trim();
                }
                if (typeof body.icon === 'string') {
                    l.icon = body.icon;
                }
                if (body.archived === true) {
                    l.archived_at = api.now();
                } else if (body.archived === false) {
                    delete l.archived_at;
                }
                if (typeof body.position === 'number') {
                    var all = data.todo_lists;
                    all.splice(all.indexOf(l), 1);
                    var peers = all.filter(function (x) {
                        return (x.channel_id || '') === (l.channel_id || '');
                    });
                    var before = peers[Math.max(0, Math.min(body.position, peers.length))];
                    all.splice(before ? all.indexOf(before) : all.length, 0, l);
                }
                l.update_at = api.now();
                listChanged(l);
                return api.json(detail(l));
            });
        });
        api.route('DELETE', b + '/api/v1/lists/:list', function (req, p) {
            return listOr404(p, function (l) {
                data.todo_lists.splice(data.todo_lists.indexOf(l), 1);
                data.favorites = data.favorites.filter(function (id) {
                    return id !== l.id;
                });
                listChanged(l);
                return api.ok();
            });
        });
        ['PUT', 'DELETE'].forEach(function (method) {
            api.route(method, b + '/api/v1/lists/:list/favorite', function (req, p) {
                return listOr404(p, function (l) {
                    data.favorites = data.favorites.filter(function (id) {
                        return id !== l.id;
                    });
                    if (method === 'PUT') {
                        data.favorites.push(l.id);
                    }
                    listChanged(l);
                    return api.ok();
                });
            });
        });
        function patchItem(item, body) {
            ['message', 'description', 'assignee_id', 'due', 'post_id'].forEach(function (k) {
                if (typeof body[k] === 'string') {
                    if (body[k]) {
                        item[k] = body[k];
                    } else {
                        delete item[k];
                    }
                }
            });
            if (body.done === true && !item.done_at) {
                item.done_by = S.me.id;
                item.done_at = api.now();
            } else if (body.done === false) {
                delete item.done_by;
                delete item.done_at;
            }
            item.update_at = api.now();
        }
        api.route('POST', b + '/api/v1/lists/:list/items', function (req, p) {
            return listOr404(p, function (l) {
                var t = api.now();
                var item = {id: api.newId(), list_id: l.id, message: '', creator_id: S.me.id, create_at: t, update_at: t};
                patchItem(item, req.body || {});
                l.items = l.items || [];
                var open = l.items.filter(isOpen);
                l.items.splice(open.length, 0, item);
                listChanged(l);
                return api.json(item, 201);
            });
        });
        api.route('PATCH', b + '/api/v1/lists/:list/items/:item', function (req, p) {
            return listOr404(p, function (l) {
                var item = (l.items || []).find(function (x) {
                    return x.id === p.item;
                });
                if (!item) {
                    return pluginError(404, 'todo not found');
                }
                var body = req.body || {};
                patchItem(item, body);
                if (typeof body.position === 'number' && isOpen(item)) {
                    l.items.splice(l.items.indexOf(item), 1);
                    var open = l.items.filter(isOpen);
                    var before = open[Math.max(0, Math.min(body.position, open.length))];
                    l.items.splice(before ? l.items.indexOf(before) : open.length, 0, item);
                }
                listChanged(l);
                return api.json(item);
            });
        });
        api.route('DELETE', b + '/api/v1/lists/:list/items/:item', function (req, p) {
            return listOr404(p, function (l) {
                l.items = (l.items || []).filter(function (x) {
                    return x.id !== p.item;
                });
                listChanged(l);
                return api.ok();
            });
        });
        api.route('POST', b + '/api/v1/lists/:list/items/:item/send', function (req, p) {
            // Sent to someone: it leaves the list here (the demo has nobody else to receive it).
            return listOr404(p, function (l) {
                l.items = (l.items || []).filter(function (x) {
                    return x.id !== p.item;
                });
                listChanged(l);
                return api.json({status: 'OK'});
            });
        });
        api.route('GET', b + '/api/v1/targets', function (req) {
            var cid = req.query.get('channel_id');
            var lists = data.todo_lists.filter(function (l) {
                return !l.archived_at && ((cid && l.channel_id === cid) || !l.channel_id);
            });
            var ofChannel = lists.find(function (l) {
                return cid && l.channel_id === cid;
            });
            var mine = lists.find(function (l) {
                return l.default;
            }) || lists.find(function (l) {
                return !l.channel_id;
            });
            return api.json({lists: lists.map(info), default_id: (ofChannel || mine || {}).id || ''});
        });
        api.route('PUT', b + '/api/v1/channels/:cid/follow', function (req, p) {
            channelList(p.cid).following = true;
            return api.json({following: true});
        });
        api.route('DELETE', b + '/api/v1/channels/:cid/follow', function (req, p) {
            channelList(p.cid).following = false;
            return api.json({following: false});
        });
    }

    // --- Memes -------------------------------------------------------------------------------------------------------

    function memes() {
        var data = app(MEMES);
        data.templates = data.templates || [];
        data.recent = data.recent || [];
        var b = '/plugins/' + MEMES + '/api/v1';

        function thumb(name, width) {
            return S.media[b + '/templates/' + name + '/thumbnail?width=' + (width > 240 ? 480 : 240)] ||
                S.media[b + '/templates/' + name + '/thumbnail?width=480'] || S.media[b + '/templates/' + name + '/thumbnail?width=240'];
        }

        // render draws the captions on the template's picture, like the server does, in the page.
        function render(name, captions) {
            var rel = thumb(name, 480);
            if (!rel) {
                return Promise.resolve(null);
            }
            return fetch(location.origin + api.media(rel).file).then(function (r) {
                return r.blob();
            }).then(function (blob) {
                if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
                    return blob;
                }
                return createImageBitmap(blob).then(function (img) {
                    var canvas = new OffscreenCanvas(img.width, img.height);
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    var size = Math.round(img.width / 11);
                    ctx.font = 'bold ' + size + 'px Impact, "Anton", "Arial Black", sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillStyle = '#fff';
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = Math.max(2, size / 9);
                    ctx.lineJoin = 'round';
                    var places = [['top', size * 1.1], ['middle', img.height / 2 + size / 3], ['bottom', img.height - size * 0.4]];
                    places.forEach(function (pl) {
                        var text = (captions[pl[0]] || '').toUpperCase();
                        if (text) {
                            ctx.strokeText(text, img.width / 2, pl[1], img.width * 0.94);
                            ctx.fillText(text, img.width / 2, pl[1], img.width * 0.94);
                        }
                    });
                    return canvas.convertToBlob({type: 'image/jpeg', quality: 0.85});
                });
            });
        }
        function captionsOf(q) {
            return {top: q.get('top') || '', middle: q.get('middle') || '', bottom: q.get('bottom') || ''};
        }

        api.route('GET', b + '/templates', function () {
            return api.json(data.templates);
        });
        api.route('GET', b + '/recent', function () {
            return api.json(data.recent);
        });
        api.route('GET', b + '/config', function () {
            return api.json({can_add: false, max_file_size: (data.config || {}).max_file_size || 0});
        });
        api.route('GET', b + '/templates/:name/thumbnail', function (req, p) {
            var rel = thumb(p.name, api.int(req.query.get('width'), 240));
            return rel ? api.media(rel) : pluginError(404, 'not found');
        });
        api.route('GET', b + '/templates/:name/render', function (req, p) {
            return render(p.name, captionsOf(req.query)).then(function (blob) {
                return blob ? {blob: blob} : pluginError(404, 'not found');
            });
        });
        api.route('POST', b + '/memes', function (req) {
            var body = req.body || {};
            return render(body.template, body).then(function (blob) {
                if (!blob) {
                    return pluginError(404, 'not found');
                }
                var st = api.state();
                var id = api.newId();
                st.blobs['file:' + id] = blob;
                st.files[id] = {id: id, user_id: st.me.id, channel_id: body.channel_id, name: body.template + '.jpg', extension: 'jpg',
                    size: blob.size, mime_type: 'image/jpeg', width: 500, height: 500, has_preview_image: true, create_at: api.now()};
                var meme = {template: body.template, top: body.top || '', middle: body.middle || '', bottom: body.bottom || '', create_at: api.now()};
                data.recent.unshift(meme);
                var post = api.createPost({channel_id: body.channel_id, root_id: body.root_id || '', message: '', file_ids: [id],
                    props: {am_meme: meme}});
                return api.json(post, 201);
            });
        });
        api.route('POST', b + '/templates', function () {
            return pluginError(403, 'Templates can\'t be added in the demo.');
        });
    }

    // --- GIFs ----------------------------------------------------------------------------------------------------------

    function gifs() {
        var data = app(GIFS);
        data.pages = data.pages || {};
        data.categories = data.categories || {};
        data.favorites = data.favorites || [];
        data.recent = data.recent || [];
        var b = '/plugins/' + GIFS + '/api/v1';

        function page(kind, q) {
            var exact = data.pages[kind + ':' + (q || '')];
            if (exact) {
                return exact;
            }
            // Any other search: the recorded items whose title matches, or else the featured ones.
            var all = [];
            Object.keys(data.pages).forEach(function (k) {
                if (k.indexOf(kind + ':') === 0) {
                    (data.pages[k].items || []).forEach(function (item) {
                        if (!all.some(function (x) {
                            return x.id === item.id;
                        })) {
                            all.push(item);
                        }
                    });
                }
            });
            var words = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
            var hits = all.filter(function (item) {
                var text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
                return words.some(function (w) {
                    return text.indexOf(w) >= 0;
                });
            });
            return {items: hits.length ? hits : (data.pages[kind + ':'] || {items: []}).items};
        }
        function itemById(kind, id) {
            var found = null;
            Object.keys(data.pages).some(function (k) {
                found = (data.pages[k].items || []).find(function (x) {
                    return x.id === id && (x.kind || 'gif') === kind;
                });
                return found;
            });
            return found;
        }

        api.route('GET', b + '/config', function () {
            return api.json(Object.assign({configured: true, stickers: true}, data.config || {}, {can_upload: false}));
        });
        api.route('GET', b + '/categories', function (req) {
            return api.json(data.categories[req.query.get('kind') || 'gif'] || []);
        });
        api.route('GET', b + '/featured', function (req) {
            return api.json(page(req.query.get('kind') || 'gif', ''));
        });
        api.route('GET', b + '/search', function (req) {
            return api.json(page(req.query.get('kind') || 'gif', req.query.get('q') || ''));
        });
        api.route('GET', b + '/autocomplete', function (req) {
            var q = (req.query.get('q') || '').toLowerCase();
            var names = [];
            Object.keys(data.categories).forEach(function (kind) {
                (data.categories[kind] || []).forEach(function (c) {
                    var term = (c.searchterm || c.name || '').toLowerCase();
                    if (term.indexOf(q) === 0 && names.indexOf(term) < 0) {
                        names.push(term);
                    }
                });
            });
            return api.json(names.slice(0, api.int(req.query.get('limit'), 6)));
        });
        api.route('GET', b + '/favorites', function () {
            return api.json(data.favorites);
        });
        api.route('GET', b + '/recent', function () {
            return api.json(data.recent);
        });
        api.route('POST', b + '/favorites', function (req) {
            var body = req.body || {};
            var item = itemById(body.kind || 'gif', body.id);
            if (item && !data.favorites.some(function (x) {
                return x.id === item.id;
            })) {
                data.favorites.unshift(item);
            }
            return api.json(data.favorites);
        });
        api.route('DELETE', b + '/favorites/:kind/:id', function (req, p) {
            data.favorites = data.favorites.filter(function (x) {
                return x.id !== p.id;
            });
            return api.json(data.favorites);
        });
        api.route('POST', b + '/post', function (req) {
            var body = req.body || {};
            var item = itemById(body.kind || 'gif', body.id);
            if (!item) {
                return pluginError(404, 'not found');
            }
            data.recent = [item].concat(data.recent.filter(function (x) {
                return x.id !== item.id;
            })).slice(0, 30);
            var url = (item.image || item.post || item.preview || {}).url || '';
            var post = api.createPost({channel_id: body.channel_id, root_id: body.root_id || '', type: 'custom_antimatter_gif',
                message: '![' + (item.title || 'GIF') + '](' + location.origin + (window.basename || '') + url + ')',
                props: {antimatter_gif: item, from_plugin: 'true'}});
            return api.json(post, 201);
        });
        api.route('POST', b + '/upload', function () {
            return pluginError(403, 'Uploads aren\'t part of the demo.');
        });
    }

    // --- Voice channels ------------------------------------------------------------------------------------------------

    function voice() {
        var data = app(VOICE);
        var b = '/plugins/' + VOICE + '/api/v1';
        api.route('GET', b + '/config', function () {
            // Opening a voice channel doesn't join it: the visitor joins with the channel's Join voice button.
            return api.json(Object.assign({allow_video: true}, data.config || {}, {auto_join: false}));
        });
        api.route('GET', b + '/channels', function () {
            return api.json(data.channels || []);
        });
        api.route('GET', b + '/channels/:cid', function (req, p) {
            var c = (data.channels || []).find(function (x) {
                return x.channel_id === p.cid;
            });
            return api.json(c || {channel_id: p.cid, team_id: (S.channels[p.cid] || {}).team_id || '', voice: false, deafened_sessions: {}});
        });
        api.route('PUT', b + '/channels/:cid', function (req, p) {
            data.channels = data.channels || [];
            var c = data.channels.find(function (x) {
                return x.channel_id === p.cid;
            });
            if (!c) {
                c = {channel_id: p.cid, team_id: (S.channels[p.cid] || {}).team_id || '', voice: false, deafened_sessions: {}};
                data.channels.push(c);
            }
            c.voice = Boolean((req.body || {}).voice);
            event(VOICE, 'voice_channel_updated', {channel_id: c.channel_id, team_id: c.team_id, voice: c.voice}, {});
            return api.json(c);
        });
        api.route('PUT', b + '/channels/:cid/sessions/:sid/deafened', function () {
            return api.ok();
        });
    }

    // --- Calls -------------------------------------------------------------------------------------------------------------

    // The Calls app's server, on the visitor only: starting or joining a call (in a channel, a direct message or a voice
    // channel) works as on a real server, with its events and its post, but the visitor is alone in it and nothing is
    // sent anywhere. The calls client talks to it on its own websocket (mock/socket.js): it joins, gets "join" back,
    // then connects its media (mock/media.js stands in for WebRTC; its descriptions are answered here), and says
    // when it mutes, unmutes, turns its camera on or off, raises its hand, reacts and leaves.
    function calls() {
        var data = app(CALLS);
        var b = '/plugins/' + CALLS;
        var prefix = 'custom_' + CALLS + '_';
        var config = {DefaultEnabled: true, AllowEnableCalls: true, EnableRinging: false, NeedsTURNCredentials: false, ICEServersConfigs: [],
            ICEServers: null, AllowScreenSharing: true, EnableVideo: true, EnableRecordings: false, EnableTranscriptions: false,
            EnableLiveCaptions: false, TranscribeFromClients: false, MaxCallParticipants: 0, GroupCallsAllowed: true, HostControlsAllowed: true,
            EnableSimulcast: false, EnableAV1: false, EnableDCSignaling: false, MaxRecordingDuration: 60};
        var active = {}; // channel id -> the call going on there
        var sessions = {}; // connection id -> {channelId, sessionId}
        var ANSWER = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=antimatter-demo', 't=0 0', 'a=group:BUNDLE 0',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n');

        function channelProps(cid) {
            return ((data.channels || []).find(function (x) {
                return x.channel_id === cid;
            }) || {}).props || {};
        }
        function send(name, payload, broadcast) {
            api.emit(prefix + name, payload, broadcast);
        }
        function clientState(call) {
            return {id: call.id, start_at: call.start_at, owner_id: call.owner_id, host_id: call.host_id, thread_id: call.thread_id,
                post_id: call.post_id, screen_sharing_session_id: call.screen || '',
                sessions: api.values(call.sessions).map(function (x) {
                    return {session_id: x.session_id, user_id: x.user_id, unmuted: x.unmuted, raised_hand: x.raised_hand, video: x.video};
                })};
        }
        function callOf(conn) {
            var s = sessions[conn];
            var call = s && active[s.channelId];
            return call && call.sessions[s.sessionId] ? {call: call, session: call.sessions[s.sessionId]} : null;
        }
        function startCall(cid, title, threadId) {
            var c = S.channels[cid];
            var t = api.now();
            var call = {id: api.newId(), channel_id: cid, start_at: t, owner_id: S.me.id, host_id: S.me.id, thread_id: threadId || '',
                post_id: '', sessions: {}, participants: {}, screen: ''};
            if (!channelProps(cid).disable_call_post) {
                var text = (S.me.username || 'Someone') + ' started a call';
                var props = {attachments: [{fallback: text, title: text, text: text}], start_at: t, title: title || ''};
                if (c.type === 'D') {
                    props.call_status = 'calling';
                }
                var post = api.createPost({channel_id: cid, root_id: threadId || '', message: text, type: 'custom_calls', props: props});
                if (post) {
                    call.post_id = post.id;
                    call.thread_id = threadId || post.id;
                }
            }
            active[cid] = call;
            send('call_start', {id: call.id, channelID: cid, start_at: t, thread_id: call.thread_id, post_id: call.post_id, owner_id: call.owner_id,
                host_id: call.host_id}, {channel_id: cid});
            return call;
        }
        function endCall(call) {
            var c = S.channels[call.channel_id] || {};
            delete active[call.channel_id];
            send('call_end', {channelID: call.channel_id}, {channel_id: call.channel_id});
            var post = call.post_id && S.posts[call.post_id];
            if (post) {
                var who = Object.keys(call.participants);
                var cancelled = c.type === 'D' && who.length < 2;
                var text = cancelled ? 'Call canceled' : 'Call ended';
                post.message = text;
                post.props = Object.assign({}, post.props, {attachments: [{fallback: text, title: text, text: text}], end_at: api.now(),
                    call_status: cancelled ? 'canceled_by_caller' : 'ended', participants: who});
                post.update_at = api.now();
                api.emit('post_edited', {post: JSON.stringify(post)}, {channel_id: post.channel_id});
            }
        }
        function leave(conn) {
            var x = callOf(conn);
            delete sessions[conn];
            if (!x) {
                return;
            }
            delete x.call.sessions[x.session.session_id];
            if (x.call.screen === x.session.session_id) {
                x.call.screen = '';
            }
            send('user_left', {user_id: x.session.user_id, session_id: x.session.session_id, channelID: x.call.channel_id}, {channel_id: x.call.channel_id});
            if (!Object.keys(x.call.sessions).length) {
                endCall(x.call);
            }
        }

        api.socketAction(prefix + 'join', function (d, conn) {
            var cid = (d || {}).channelID;
            var c = S.channels[cid];
            if (!c || !S.myMembers[cid]) {
                send('error', {data: 'forbidden', connID: conn}, {connection_id: conn});
                return {};
            }
            var call = active[cid] || startCall(cid, d.title, d.threadID);
            call.sessions[conn] = {session_id: conn, user_id: S.me.id, unmuted: false, raised_hand: 0, video: false};
            call.participants[S.me.id] = true;
            sessions[conn] = {channelId: cid, sessionId: conn};
            send('join', {connID: conn}, {connection_id: conn});
            send('user_joined', {user_id: S.me.id, session_id: conn, channelID: cid}, {channel_id: cid});
            send('call_state', {channel_id: cid, call: JSON.stringify(clientState(call))}, {user_id: S.me.id});
            return {};
        });
        api.socketAction(prefix + 'leave', function (d, conn) {
            leave(conn);
            return {};
        });
        api.socketAction(prefix + 'reconnect', function () {
            return {};
        });
        // What the client says about itself, told to the channel as the server does.
        [['mute', 'user_muted', function (s) {
            s.unmuted = false;
        }], ['unmute', 'user_unmuted', function (s) {
            s.unmuted = true;
        }], ['video_on', 'user_video_on', function (s) {
            s.video = true;
        }], ['video_off', 'user_video_off', function (s) {
            s.video = false;
        }], ['voice_on', 'user_voice_on', null], ['voice_off', 'user_voice_off', null],
        ['raise_hand', 'user_raise_hand', function (s) {
            s.raised_hand = api.now();
        }], ['unraise_hand', 'user_unraise_hand', function (s) {
            s.raised_hand = 0;
        }], ['screen_on', 'user_screen_on', function (s, call) {
            call.screen = s.session_id;
        }], ['screen_off', 'user_screen_off', function (s, call) {
            call.screen = '';
        }]].forEach(function (a) {
            api.socketAction(prefix + a[0], function (d, conn) {
                var x = callOf(conn);
                if (!x) {
                    return {};
                }
                if (a[2]) {
                    a[2](x.session, x.call);
                }
                var payload = {userID: x.session.user_id, session_id: x.session.session_id, channelID: x.call.channel_id};
                if (a[0] === 'raise_hand' || a[0] === 'unraise_hand') {
                    payload.raised_hand = x.session.raised_hand;
                }
                send(a[1], payload, {channel_id: x.call.channel_id});
                return {};
            });
        });
        api.socketAction(prefix + 'react', function (d, conn) {
            var x = callOf(conn);
            if (!x) {
                return {};
            }
            var emoji = {};
            try {
                emoji = JSON.parse((d || {}).data || '{}');
            } catch (e) {
                // Not an emoji: nothing to show.
            }
            send('user_reacted', {user_id: x.session.user_id, session_id: x.session.session_id, channelID: x.call.channel_id, emoji: emoji,
                timestamp: api.now()}, {channel_id: x.call.channel_id});
            return {};
        });
        ['ice', 'metric', 'caption', 'call_state'].forEach(function (name) {
            api.socketAction(prefix + name, function () {
                return {};
            });
        });
        // The client's descriptions (offers, compressed, in MessagePack): the media server answers each one, which
        // "connects" the stand-in connection.
        api.socketBinary(function (conn) {
            if (!sessions[conn]) {
                return;
            }
            setTimeout(function () {
                if (sessions[conn]) {
                    send('signal', {connID: conn, data: JSON.stringify({type: 'answer', sdp: ANSWER})}, {connection_id: conn});
                }
            }, 20);
        });

        api.route('GET', b + '/config', function () {
            return api.json(config);
        });
        api.route('GET', b + '/version', function () {
            return api.json({version: data.version || '', build: 'demo'});
        });
        api.route('GET', b + '/env', function () {
            return api.json({});
        });
        api.route('GET', b + '/channels', function () {
            return api.json((data.channels || []).map(function (c) {
                var copy = Object.assign({}, c);
                delete copy.call;
                if (active[c.channel_id]) {
                    copy.call = clientState(active[c.channel_id]);
                }
                return copy;
            }));
        });
        api.route('GET', b + '/turn-credentials', function () {
            return api.json([]);
        });
        api.route('GET', b + '/calls/:cid/active', function (req, p) {
            return api.json({active: Boolean(active[p.cid])});
        });
        api.route('POST', b + '/calls/:cid/dismiss-notification', function () {
            return api.ok();
        });
        // Ending the call for everyone: the visitor is everyone.
        api.route('POST', b + '/calls/:cid/host/end', function (req, p) {
            var call = active[p.cid];
            if (call) {
                Object.keys(call.sessions).forEach(function (conn) {
                    delete sessions[conn];
                });
                call.sessions = {};
                endCall(call);
            }
            return api.ok();
        });
        api.route('POST', b + '/calls/:cid/host/:action', function () {
            return api.ok();
        });
        api.route('POST', b + '/calls/:cid/recording/:action', function () {
            return pluginError(403, 'Recordings aren\'t part of the demo.');
        });
        api.route('POST', b + '/calls/:cid/transcription/:action', function () {
            return pluginError(403, 'Transcriptions aren\'t part of the demo.');
        });
        api.route('GET', b + '/:cid', function (req, p) {
            if (!/^[a-z0-9]{26}$/.test(p.cid)) {
                return undefined;
            }
            var c = (data.channels || []).find(function (x) {
                return x.channel_id === p.cid;
            });
            var copy = Object.assign({channel_id: p.cid, enabled: true, server_default: true}, c || {});
            delete copy.call;
            return api.json(copy);
        });
        api.route('POST', b + '/:cid', function (req, p) {
            return api.json({channel_id: p.cid, enabled: Boolean((req.body || {}).enabled)});
        });
        // Signing out or leaving the page leaves the call, as the server sees the connection go.
        window.addEventListener('pagehide', function () {
            Object.keys(sessions).forEach(leave);
        });
        window.DemoCalls = {
            active: function () {
                return active;
            },
            leave: leave,
        };
    }

    // --- start --------------------------------------------------------------------------------------------------------------

    window.DemoPlugins = {
        init: function (serverApi, apps) {
            api = serverApi;
            A = apps || {};
            S = api.state();
            relay(NOTES, 'Untitled note', false);
            relay(WHITEBOARD, 'Untitled board', true);
            polls();
            todo();
            memes();
            gifs();
            voice();
            calls();
            // Any other app route: an empty success, so an app never shows an error page in the demo.
        },
    };
}());
