// What makes the demo feel used by a team: now and then someone types in the channel being read, people come and go
// (online, away), and the people the visitor writes to in a direct message type and answer (with a few canned
// lines: nobody is on the other side).
(function () {
    'use strict';
    var api;
    var S;
    var timers = [];

    var REPLIES = [
        'Thanks! I\'ll take a look this afternoon.',
        'Sounds good to me 👍',
        'Got it, I\'ll add it to the list.',
        'Good point. Let\'s bring it up at the next sync.',
        'On it!',
        'Nice, thanks for the heads-up.',
        'Let me check and get back to you.',
    ];

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    function people() {
        return api.values(S.users).filter(function (u) {
            return !u.is_bot && !u.delete_at && u.id !== S.me.id;
        });
    }

    function online(id) {
        var st = S.statuses[id];
        return st && (st.status === 'online' || st.status === 'away');
    }

    function typing(cid, userId, parentId, times) {
        for (var i = 0; i < (times || 2); i++) {
            timers.push(setTimeout(function () {
                api.emit('typing', {parent_id: parentId || '', user_id: userId}, {channel_id: cid});
            }, i * 2500));
        }
    }

    // Someone in the channel being read starts typing, and stops (the app hides it after a few seconds).
    function someoneTypes() {
        var cid = api.currentChannelId();
        var c = S.channels[cid];
        if (c && !c.delete_at && document.visibilityState === 'visible') {
            var ids = api.channelMemberIds(cid).filter(function (id) {
                return id !== S.me.id && S.users[id] && !S.users[id].is_bot && online(id);
            });
            if (ids.length) {
                typing(cid, pick(ids), '', 2);
            }
        }
        timers.push(setTimeout(someoneTypes, 25000 + Math.random() * 35000));
    }

    // Someone goes away, or comes back.
    function someoneMoves() {
        var list = people().filter(function (u) {
            var st = (S.statuses[u.id] || {}).status;
            return st === 'online' || st === 'away';
        });
        if (list.length) {
            var u = pick(list);
            var st = S.statuses[u.id];
            st.status = st.status === 'online' ? 'away' : 'online';
            st.last_activity_at = api.now();
            api.emit('status_change', {status: st.status, user_id: u.id});
        }
        timers.push(setTimeout(someoneMoves, 60000 + Math.random() * 60000));
    }

    function afterVisitorPost(post) {
        var c = S.channels[post.channel_id];
        if (!c || c.type !== 'D') {
            return;
        }
        var other = c.name.split('__').find(function (id) {
            return id !== S.me.id;
        });
        var u = S.users[other];
        if (!u || u.is_bot || u.delete_at) {
            return;
        }
        var st = S.statuses[u.id] || {};
        if (st.status === 'offline' || st.status === 'dnd') {
            return;
        }
        timers.push(setTimeout(function () {
            typing(c.id, u.id, post.root_id, 2);
        }, 1500));
        timers.push(setTimeout(function () {
            api.createPost({channel_id: c.id, root_id: post.root_id || '', message: pick(REPLIES)}, u.id);
        }, 5500 + Math.random() * 2000));
    }

    window.DemoLife = {
        start: function (serverApi) {
            api = serverApi;
            S = api.state();
            timers.push(setTimeout(someoneTypes, 12000));
            timers.push(setTimeout(someoneMoves, 45000));
        },
        afterVisitorPost: afterVisitorPost,
        visitorTyping: function () {
            return null;
        },
    };
}());
