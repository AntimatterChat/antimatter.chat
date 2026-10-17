// The default apps' routes in the demo (/plugins/<id>/...), answered from fixtures/apps.json, which
// tools/demo/record_fixtures.py records from each app's own API. What the visitor does in an app (editing a note,
// drawing, voting, ticking a todo, moving a card, checking a playbook task) is kept in memory like the rest, and the
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
    var BOARDS = 'focalboard';
    var PLAYBOOKS = 'playbooks';
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
            // Opening a voice channel would join a call, and the demo has no media server.
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

    // --- Kanban (focalboard) ---------------------------------------------------------------------------------------------

    function boards() {
        var data = app(BOARDS);
        data.boards = data.boards || {};
        data.blocks = data.blocks || {};
        data.members = data.members || {};
        data.categories = data.categories || {};
        var b = '/plugins/' + BOARDS + '/api/v2';

        function boardUser(u) {
            return {id: u.id, username: u.username, email: u.email, nickname: u.nickname || '', firstname: u.first_name || '', lastname: u.last_name || '',
                props: {}, create_at: u.create_at, update_at: u.update_at, delete_at: u.delete_at, is_bot: Boolean(u.is_bot), is_guest: false,
                roles: u.roles || ''};
        }
        function teamBoards(tid) {
            return api.values(data.boards).filter(function (x) {
                return x.teamId === tid && !x.deleteAt && !x.isTemplate;
            });
        }
        function send(tid, payload) {
            event(BOARDS, 'UPDATE_BOARD', Object.assign({teamId: tid}, payload), {user_id: S.me.id});
        }

        api.route('GET', b + '/users/me', function () {
            return api.json(Object.assign(boardUser(S.me), data.me || {}, {id: S.me.id}));
        });
        api.route('GET', b + '/users/me/config', function () {
            return api.json((data.config || []).filter(function (c) {
                return !/^onboardingTour/.test(c.name) && c.name !== 'tourCategory';
            }));
        });
        api.route('PUT', b + '/users/:uid/config', function (req) {
            return api.json(data.config || []);
        });
        api.route('GET', b + '/users/me/memberships', function () {
            return api.json(Object.keys(data.boards).map(function (bid) {
                return {boardId: bid, userId: S.me.id, roles: '', minimumRole: '', schemeAdmin: true, schemeEditor: true, schemeCommenter: true,
                    schemeViewer: true, synthetic: false};
            }));
        });
        api.route('GET', b + '/users/:uid', function (req, p) {
            var u = S.users[p.uid];
            return u ? api.json(boardUser(u)) : pluginError(404, 'not found');
        });
        api.route('GET', b + '/clientConfig', function () {
            return api.json(Object.assign({}, data.clientConfig || {}, {telemetry: false, telemetryid: ''}));
        });
        api.route('GET', b + '/teams', function () {
            return api.json(api.values(S.teams).map(function (t) {
                return {id: t.id, title: t.display_name, signupToken: '', settings: {}, modifiedBy: '', updateAt: t.update_at};
            }));
        });
        api.route('GET', b + '/teams/:tid', function (req, p) {
            var t = S.teams[p.tid];
            return t ? api.json({id: t.id, title: t.display_name, signupToken: '', settings: {}, modifiedBy: '', updateAt: t.update_at}) :
                pluginError(404, 'not found');
        });
        api.route('GET', b + '/teams/:tid/boards', function (req, p) {
            return api.json(teamBoards(p.tid));
        });
        api.route('GET', b + '/teams/:tid/boards/search/linkable', function (req, p) {
            var q = (req.query.get('q') || '').toLowerCase();
            return api.json(teamBoards(p.tid).filter(function (x) {
                return x.title.toLowerCase().indexOf(q) >= 0;
            }));
        });
        api.route('GET', b + '/teams/:tid/boards/search', function (req, p) {
            var q = (req.query.get('q') || '').toLowerCase();
            return api.json(teamBoards(p.tid).filter(function (x) {
                return x.title.toLowerCase().indexOf(q) >= 0;
            }));
        });
        api.route('GET', b + '/teams/:tid/templates', function () {
            return api.json(data.templates || []);
        });
        api.route('GET', b + '/teams/:tid/categories', function (req, p) {
            return api.json(data.categories[p.tid] || []);
        });
        api.route('POST', b + '/teams/:tid/users', function (req) {
            return api.json((req.body || []).map(function (id) {
                return S.users[id];
            }).filter(Boolean).map(boardUser));
        });
        api.route('GET', b + '/teams/:tid/users', function (req, p) {
            return api.json(api.values(S.users).filter(function (u) {
                return !u.is_bot;
            }).map(boardUser));
        });
        api.route('GET', b + '/subscriptions/:uid', function () {
            return api.json(data.subscriptions || []);
        });
        api.route('GET', b + '/boards/:bid', function (req, p) {
            var x = data.boards[p.bid];
            return x ? api.json(x) : pluginError(404, 'not found');
        });
        api.route('PATCH', b + '/boards/:bid', function (req, p) {
            var x = data.boards[p.bid];
            if (!x) {
                return pluginError(404, 'not found');
            }
            var body = req.body || {};
            ['title', 'description', 'icon', 'showDescription', 'type', 'minimumRole', 'channelId'].forEach(function (k) {
                if (body[k] !== undefined) {
                    x[k] = body[k];
                }
            });
            if (body.updatedProperties) {
                x.properties = Object.assign({}, x.properties, body.updatedProperties);
            }
            if (body.updatedCardProperties) {
                body.updatedCardProperties.forEach(function (cp) {
                    var i = x.cardProperties.findIndex(function (y) {
                        return y.id === cp.id;
                    });
                    if (i >= 0) {
                        x.cardProperties[i] = cp;
                    } else {
                        x.cardProperties.push(cp);
                    }
                });
            }
            if (body.deletedCardProperties) {
                x.cardProperties = x.cardProperties.filter(function (y) {
                    return body.deletedCardProperties.indexOf(y.id) < 0;
                });
            }
            x.updateAt = api.now();
            x.modifiedBy = S.me.id;
            send(x.teamId, {action: 'UPDATE_BOARD', board: x});
            return api.json(x);
        });
        api.route('GET', b + '/boards/:bid/members', function (req, p) {
            return api.json(data.members[p.bid] || []);
        });
        api.route('GET', b + '/boards/:bid/blocks', function (req, p) {
            var list = data.blocks[p.bid] || [];
            var only = req.query.get('block_id');
            if (only) {
                list = list.filter(function (x) {
                    return x.id === only || x.parentId === only;
                });
            }
            return api.json(list.filter(function (x) {
                return !x.deleteAt;
            }));
        });
        api.route('PATCH', b + '/boards/:bid/blocks/:blockid', function (req, p) {
            var block = (data.blocks[p.bid] || []).find(function (x) {
                return x.id === p.blockid;
            });
            if (!block) {
                return pluginError(404, 'not found');
            }
            patchBlock(block, req.body || {});
            send((data.boards[p.bid] || {}).teamId, {action: 'UPDATE_BLOCK', block: block});
            return api.json({});
        });
        api.route('PATCH', b + '/boards/:bid/blocks/', function (req, p) {
            var body = req.body || {};
            (body.block_ids || []).forEach(function (id, i) {
                var block = (data.blocks[p.bid] || []).find(function (x) {
                    return x.id === id;
                });
                if (block) {
                    patchBlock(block, (body.block_patches || [])[i] || {});
                    send((data.boards[p.bid] || {}).teamId, {action: 'UPDATE_BLOCK', block: block});
                }
            });
            return api.json({});
        });
        api.route('POST', b + '/boards/:bid/blocks', function (req, p) {
            var t = api.now();
            var created = (req.body || []).map(function (block) {
                var x = Object.assign({}, block, {id: block.id || api.newId(), boardId: p.bid, createdBy: S.me.id, modifiedBy: S.me.id,
                    createAt: t, updateAt: t, deleteAt: 0});
                (data.blocks[p.bid] = data.blocks[p.bid] || []).push(x);
                send((data.boards[p.bid] || {}).teamId, {action: 'UPDATE_BLOCK', block: x});
                return x;
            });
            return api.json(created);
        });
        api.route('DELETE', b + '/boards/:bid/blocks/:blockid', function (req, p) {
            var block = (data.blocks[p.bid] || []).find(function (x) {
                return x.id === p.blockid;
            });
            if (block) {
                block.deleteAt = api.now();
                block.updateAt = block.deleteAt;
                send((data.boards[p.bid] || {}).teamId, {action: 'UPDATE_BLOCK', block: block});
            }
            return api.json({});
        });
        api.route('POST', b + '/boards/:bid/blocks/:blockid/undelete', function (req, p) {
            var block = (data.blocks[p.bid] || []).find(function (x) {
                return x.id === p.blockid;
            });
            if (block) {
                block.deleteAt = 0;
                block.updateAt = api.now();
                send((data.boards[p.bid] || {}).teamId, {action: 'UPDATE_BLOCK', block: block});
            }
            return api.json(block || {});
        });
        api.route('GET', b + '/boards/:bid/statistics', function () {
            return api.json({});
        });
        api.route('POST', b + '/teams/:tid/categories', function (req, p) {
            var cat = Object.assign({id: api.newId(), userID: S.me.id, teamID: p.tid, createAt: api.now(), updateAt: api.now(), deleteAt: 0,
                collapsed: false, sorting: '', type: 'custom', boardMetadata: [], sortOrder: 0}, req.body || {});
            (data.categories[p.tid] = data.categories[p.tid] || []).push(cat);
            event(BOARDS, 'UPDATE_CATEGORY', {teamId: p.tid, category: cat}, {user_id: S.me.id});
            return api.json(cat);
        });
        api.route('PUT', b + '/teams/:tid/categories/:catid', function (req, p) {
            var list = data.categories[p.tid] || [];
            var i = list.findIndex(function (x) {
                return x.id === p.catid;
            });
            if (i >= 0) {
                list[i] = Object.assign({}, list[i], req.body || {}, {updateAt: api.now()});
                event(BOARDS, 'UPDATE_CATEGORY', {teamId: p.tid, category: list[i]}, {user_id: S.me.id});
            }
            return api.json(list[i] || {});
        });
        api.route('PUT', b + '/teams/:tid/categories/:catid/boards/:bid', function () {
            return api.json({});
        });
        api.route('POST', b + '/teams/:tid/boards', function () {
            return pluginError(403, 'New boards aren\'t part of the demo: try the Lumen roadmap.');
        });
        api.route('POST', b + '/boards', function () {
            return pluginError(403, 'New boards aren\'t part of the demo: try the Lumen roadmap.');
        });
        // The plugin's images (onboarding pictures, the emoji sheet).
        api.route('GET', '/plugins/' + BOARDS + '/static/:name', function (req, p) {
            var rel = S.media['/plugins/' + BOARDS + '/static/' + p.name];
            return rel ? api.media(rel) : pluginError(404, 'not found');
        });
    }

    function patchBlock(block, patch) {
        var t = api.now();
        if (patch.title !== undefined) {
            block.title = patch.title;
        }
        if (patch.parentId !== undefined) {
            block.parentId = patch.parentId;
        }
        if (patch.schema !== undefined) {
            block.schema = patch.schema;
        }
        block.fields = Object.assign({}, block.fields || {}, patch.updatedFields || {});
        (patch.deletedFields || []).forEach(function (k) {
            delete block.fields[k];
        });
        block.updateAt = t;
        block.modifiedBy = S.me.id;
    }

    // --- Playbooks: REST, and its GraphQL queries answered by a small executor ---------------------------------------------

    function playbooks() {
        var data = app(PLAYBOOKS);
        data.runs = data.runs || {};
        data.playbooks = data.playbooks || {};
        data.metadata = data.metadata || {};
        data.status_updates = data.status_updates || {};
        data.categories = data.categories || {};
        data.owners = data.owners || {};
        var favorites = {};
        var b = '/plugins/' + PLAYBOOKS + '/api/v0';

        function runUpdated(run) {
            run.update_at = api.now();
            event(PLAYBOOKS, 'playbook_run_updated', {payload: JSON.stringify(run)}, {channel_id: run.channel_id});
        }
        function tasks(run) {
            var total = 0;
            var closed = 0;
            (run.checklists || []).forEach(function (c) {
                (c.items || []).forEach(function (it) {
                    total += 1;
                    if (it.state === 'closed') {
                        closed += 1;
                    }
                });
            });
            return {total: total, closed: closed};
        }
        function filterRuns(q) {
            var list = api.values(data.runs);
            var team = q.team_id || q.teamID;
            if (team) {
                list = list.filter(function (r) {
                    return r.team_id === team;
                });
            }
            var channel = q.channel_id || q.channelID;
            if (channel) {
                list = list.filter(function (r) {
                    return r.channel_id === channel;
                });
            }
            var statuses = [].concat(q.statuses || q.status || []).filter(Boolean);
            if (statuses.length) {
                list = list.filter(function (r) {
                    return statuses.indexOf(r.current_status) >= 0;
                });
            }
            var participant = q.participant_id || q.participant_or_follower_id || q.participantOrFollowerID;
            if (participant) {
                list = list.filter(function (r) {
                    return (r.participant_ids || []).indexOf(participant) >= 0 || r.owner_user_id === participant;
                });
            }
            var types = [].concat(q.types || []).filter(Boolean);
            if (types.length) {
                list = list.filter(function (r) {
                    return !r.type || types.indexOf(r.type) >= 0;
                });
            }
            var sort = q.sort || 'create_at';
            var dir = (q.direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;
            list.sort(function (x, y) {
                var a = x[sort] !== undefined ? x[sort] : x.create_at;
                var c = y[sort] !== undefined ? y[sort] : y.create_at;
                return (a > c ? 1 : a < c ? -1 : 0) * dir;
            });
            return list;
        }
        function queryObject(q) {
            var o = {};
            q.forEach(function (v, k) {
                if (o[k] !== undefined) {
                    o[k] = [].concat(o[k], v);
                } else {
                    o[k] = v;
                }
            });
            return o;
        }
        function paged(list, q) {
            var per = api.int(q.per_page, 1000);
            var page = api.int(q.page, 0);
            var items = per ? list.slice(page * per, page * per + per) : [];
            return {items: items, total_count: list.length, page_count: per ? Math.ceil(list.length / per) : 0, per_page: per,
                has_more: per ? (page + 1) * per < list.length : list.length > 0};
        }

        api.route('GET', b + '/settings', function () {
            return api.json(data.settings || {enable_experimental_features: false, enable_task_requirements: false});
        });
        api.route('GET', b + '/bot/connect', function () {
            return {text: '', status: 200};
        });
        api.route('GET', b + '/actions/channels/:cid', function () {
            return api.json([]);
        });
        api.route('GET', b + '/runs', function (req) {
            return api.json(paged(filterRuns(queryObject(req.query)), queryObject(req.query)));
        });
        api.route('GET', b + '/runs/owners', function (req) {
            return api.json(data.owners[req.query.get('team_id')] || []);
        });
        api.route('GET', b + '/runs/channels', function () {
            return api.json(api.values(data.runs).map(function (r) {
                return r.channel_id;
            }));
        });
        api.route('GET', b + '/runs/:id', function (req, p) {
            var r = data.runs[p.id];
            return r ? api.json(r) : pluginError(404, 'not found');
        });
        api.route('GET', b + '/runs/:id/metadata', function (req, p) {
            return api.json(data.metadata[p.id] || {});
        });
        api.route('GET', b + '/runs/:id/status-updates', function (req, p) {
            return api.json(data.status_updates[p.id] || []);
        });
        api.route('PUT', b + '/runs/:id/checklists/:c/item/:i/state', function (req, p) {
            var run = data.runs[p.id];
            var item = run && ((run.checklists[api.int(p.c, 0)] || {}).items || [])[api.int(p.i, 0)];
            if (!item) {
                return pluginError(404, 'not found');
            }
            item.state = (req.body || {}).new_state || '';
            item.state_modified = api.now();
            var count = tasks(run);
            run.task_completed = count.closed;
            run.task_total = count.total;
            runUpdated(run);
            return api.json({});
        });
        api.route('PUT', b + '/runs/:id/checklists/:c/item/:i/assignee', function (req, p) {
            var run = data.runs[p.id];
            var item = run && ((run.checklists[api.int(p.c, 0)] || {}).items || [])[api.int(p.i, 0)];
            if (item) {
                item.assignee_id = (req.body || {}).assignee_id || '';
                item.assignee_modified = api.now();
                runUpdated(run);
            }
            return api.json({});
        });
        api.route('POST', b + '/runs/:id/checklists/:c/add', function (req, p) {
            var run = data.runs[p.id];
            var list = run && run.checklists[api.int(p.c, 0)];
            if (list) {
                var item = Object.assign({id: api.newId(), title: '', state: '', state_modified: 0, assignee_id: '', description: ''}, req.body || {});
                list.items.push(item);
                runUpdated(run);
            }
            return api.json({});
        });
        api.route('POST', b + '/runs/:id/status', function (req, p) {
            var run = data.runs[p.id];
            if (!run) {
                return pluginError(404, 'not found');
            }
            var body = req.body || {};
            var u = {id: api.newId(), create_at: api.now(), delete_at: 0, message: body.message || '', author_user_name: S.me.username};
            (data.status_updates[p.id] = data.status_updates[p.id] || []).unshift(u);
            run.last_status_update_at = u.create_at;
            run.status_posts = (run.status_posts || []).concat([{id: u.id, create_at: u.create_at, delete_at: 0}]);
            api.createPost({channel_id: run.channel_id, type: 'custom_run_update', message: u.message,
                props: {authorUsername: S.me.username, numTasks: tasks(run).total, numTasksChecked: tasks(run).closed, participantIds: run.participant_ids,
                    playbookRunId: run.id, runName: run.name, from_plugin: 'true'}});
            runUpdated(run);
            return api.json({});
        });
        api.route('PUT', b + '/runs/:id/finish', function (req, p) {
            var run = data.runs[p.id];
            if (run) {
                run.current_status = 'Finished';
                run.end_at = api.now();
                runUpdated(run);
            }
            return api.json({});
        });
        api.route('GET', b + '/playbooks', function (req) {
            var q = queryObject(req.query);
            var list = api.values(data.playbooks).filter(function (x) {
                return (!q.team_id || x.team_id === q.team_id) && (q.with_archived === 'true' || !x.delete_at) &&
                    (!q.search_term || (x.title || '').toLowerCase().indexOf(q.search_term.toLowerCase()) >= 0);
            }).sort(function (x, y) {
                return (x.title || '').localeCompare(y.title || '');
            });
            return api.json(paged(list, q));
        });
        api.route('GET', b + '/playbooks/:id', function (req, p) {
            var x = data.playbooks[p.id];
            return x ? api.json(x) : pluginError(404, 'not found');
        });
        api.route('GET', b + '/playbooks/:id/property_fields', function () {
            return api.json([]);
        });
        api.route('GET', b + '/my_categories', function (req) {
            return api.json(data.categories[req.query.get('team_id')] || []);
        });
        api.route('GET', b + '/my_categories/favorites', function (req) {
            return api.json(Boolean(favorites[req.query.get('item_id')]));
        });
        api.route('POST', b + '/runs', function () {
            return pluginError(403, 'Starting a run isn\'t part of the demo.');
        });

        // GraphQL.
        var playbookOf = function (id) {
            return data.playbooks[id] || null;
        };
        var resolvers = {
            Query: {
                runs: function (args) {
                    var list = filterRuns({teamID: args.teamID, channelID: args.channelID, statuses: args.statuses,
                        participantOrFollowerID: args.participantOrFollowerID, sort: args.sort, direction: args.direction, types: args.types});
                    var start = args.after ? Math.max(0, list.findIndex(function (r) {
                        return r.id === args.after;
                    }) + 1) : 0;
                    var page = args.first ? list.slice(start, start + args.first) : list.slice(start);
                    return {__typename: 'RunConnection', totalCount: list.length, edges: page.map(function (r) {
                        return {__typename: 'RunEdge', cursor: r.id, node: runNode(r)};
                    }), pageInfo: {__typename: 'PageInfo', endCursor: page.length ? page[page.length - 1].id : '', hasNextPage: start + page.length < list.length,
                        startCursor: page.length ? page[0].id : '', hasPreviousPage: start > 0}};
                },
                run: function (args) {
                    return data.runs[args.id] ? runNode(data.runs[args.id]) : null;
                },
                playbook: function (args) {
                    return playbookOf(args.id) ? playbookNode(playbookOf(args.id)) : null;
                },
                playbooks: function (args) {
                    return api.values(data.playbooks).filter(function (x) {
                        return !args.teamID || x.team_id === args.teamID;
                    }).map(playbookNode);
                },
            },
        };
        function runNode(r) {
            var count = tasks(r);
            return gqlView('Run', r, {
                playbook: function () {
                    return playbookOf(r.playbook_id) ? playbookNode(playbookOf(r.playbook_id)) : null;
                },
                numTasks: count.total,
                numTasksClosed: count.closed,
                lastUpdatedAt: r.last_status_update_at || r.update_at || r.create_at,
                propertyFields: [],
                isFavorite: Boolean(favorites[r.id]),
                checklists: (r.checklists || []).map(checklistNode),
            });
        }
        function playbookNode(pb) {
            return gqlView('Playbook', pb, {
                checklists: (pb.checklists || []).map(checklistNode),
                members: (pb.members || []).map(function (m) {
                    return gqlView('Member', m, {});
                }),
                metrics: (pb.metrics || []).map(function (m) {
                    return gqlView('PlaybookMetricConfig', m, {});
                }),
                isFavorite: Boolean(favorites[pb.id]),
                propertyFields: [],
            });
        }
        function checklistNode(c) {
            return gqlView('Checklist', c, {items: (c.items || []).map(function (it) {
                return gqlView('ChecklistItem', it, {taskActions: [], requirements: []});
            })});
        }
        var mutations = {
            SetRunFavorite: function (v) {
                favorites[v.id] = v.fav;
                return {setRunFavorite: ''};
            },
            UpdatePlaybookFavorite: function (v) {
                favorites[v.id] = v.favorite;
                return {updatePlaybookFavorite: ''};
            },
        };
        api.route('POST', b + '/query', function (req) {
            var body = req.body || {};
            var op = body.operationName || '';
            try {
                if (/^\s*mutation\b/.test(body.query || '')) {
                    var fn = mutations[op];
                    var out = fn ? fn(body.variables || {}) : {};
                    if (!fn) {
                        var field = (/\{\s*([A-Za-z_]+)/.exec(body.query || '') || [])[1] || 'result';
                        out[field] = '';
                    }
                    return api.json({data: out});
                }
                return api.json({data: window.DemoGraphQL.execute(body.query || '', body.variables || {}, resolvers.Query)});
            } catch (e) {
                return api.json({data: null, errors: [{message: String(e && e.message || e)}]});
            }
        });
    }

    // gqlView makes a GraphQL object out of a REST one: its camelCase fields read the snake_case keys (teamID reads
    // team_id), with some fields computed.
    function gqlView(type, obj, extra) {
        return {__typename: type, __obj: obj, __extra: extra || {}};
    }

    // --- Calls -------------------------------------------------------------------------------------------------------------

    function calls() {
        var data = app(CALLS);
        var b = '/plugins/' + CALLS;
        var config = {DefaultEnabled: true, AllowEnableCalls: true, EnableRinging: false, NeedsTURNCredentials: false, ICEServersConfigs: [],
            ICEServers: null, AllowScreenSharing: true, EnableVideo: true, EnableRecordings: false, EnableTranscriptions: false,
            EnableLiveCaptions: false, TranscribeFromClients: false, MaxCallParticipants: 0, GroupCallsAllowed: true, HostControlsAllowed: true,
            EnableSimulcast: false, EnableAV1: false, EnableDCSignaling: false, MaxRecordingDuration: 60};
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
                return copy;
            }));
        });
        api.route('GET', b + '/turn-credentials', function () {
            return api.json([]);
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
            boards();
            playbooks();
            calls();
            // Any other app route: an empty success, so an app never shows an error page in the demo.
        },
        gqlView: gqlView,
    };
}());
