// The demo's websocket: window.WebSocket is replaced, for the app's own socket (/api/v4/websocket), by a fake one
// fed by the mock server (DemoServer.emit). It speaks the server's protocol: a "hello" event first, events numbered
// from 0 (the app reconnects when a number is skipped), and an "OK" reply to each action the app sends (typing,
// ping, statuses...). Each socket has its own connection id, as on the server (the Calls app opens a second one for
// the call it joins, and tells its events by that id); one that reconnects with its id keeps it. Other sockets are
// left alone.
(function () {
    'use strict';
    var RealWebSocket = window.WebSocket;
    var sockets = [];

    function FakeSocket(url) {
        var self = this;
        this.url = String(url);
        this.readyState = 0;
        this.protocol = '';
        this.extensions = '';
        this.bufferedAmount = 0;
        this.binaryType = 'blob';
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this._listeners = {};
        this._seq = 0;
        this.connectionId = connectionIdFor(this.url);
        setTimeout(function () {
            if (self.readyState !== 0) {
                return;
            }
            self.readyState = 1;
            sockets.push(self);
            self._dispatch('open', {type: 'open'});
            self._event({
                event: 'hello',
                data: {connection_id: self.connectionId, server_version: window.DemoServer.serverVersion(), server_hostname: ''},
                broadcast: {omit_users: null, user_id: window.DemoServer.userId(), channel_id: '', team_id: ''},
            });
        }, 30);
    }

    // connectionIdFor: the id asked for again (a reconnection), else the page's own (DemoServer.connectionId) for the
    // app's socket, else a new one.
    function connectionIdFor(url) {
        var asked = '';
        try {
            asked = new URL(url, location.href).searchParams.get('connection_id') || '';
        } catch (e) {
            // No id asked for.
        }
        var inUse = function (id) {
            return sockets.some(function (s) {
                return s.connectionId === id && s.readyState < 2;
            });
        };
        if (asked && !inUse(asked)) {
            return asked;
        }
        var main = window.DemoServer.connectionId();
        return inUse(main) ? window.DemoServer.newId() : main;
    }

    FakeSocket.CONNECTING = 0;
    FakeSocket.OPEN = 1;
    FakeSocket.CLOSING = 2;
    FakeSocket.CLOSED = 3;
    FakeSocket.prototype.CONNECTING = 0;
    FakeSocket.prototype.OPEN = 1;
    FakeSocket.prototype.CLOSING = 2;
    FakeSocket.prototype.CLOSED = 3;

    FakeSocket.prototype.addEventListener = function (type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    };
    FakeSocket.prototype.removeEventListener = function (type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter(function (f) {
            return f !== fn;
        });
    };
    FakeSocket.prototype.dispatchEvent = function (ev) {
        this._dispatch(ev.type, ev);
        return true;
    };
    FakeSocket.prototype._dispatch = function (type, ev) {
        var handler = this['on' + type];
        try {
            if (typeof handler === 'function') {
                handler.call(this, ev);
            }
            (this._listeners[type] || []).slice().forEach(function (fn) {
                fn.call(this, ev);
            }, this);
        } catch (e) {
            setTimeout(function () {
                throw e;
            });
        }
    };
    FakeSocket.prototype._send = function (msg) {
        if (this.readyState !== 1) {
            return;
        }
        this._dispatch('message', {type: 'message', data: JSON.stringify(msg)});
    };
    // _event sends a server event, numbered.
    FakeSocket.prototype._event = function (msg) {
        msg.seq = this._seq++;
        this._send(msg);
    };

    FakeSocket.prototype.send = function (raw) {
        var self = this;
        var msg;
        // What the app sends reaches the server after send() returns, as over a network: an app that sends and then
        // changes its own state (the Calls app leaving a call) gets the server's events after that.
        if (typeof raw !== 'string') {
            // Binary: the Calls app's messages in MessagePack, which only carry its connection's descriptions (sdp).
            setTimeout(function () {
                window.DemoServer.onSocketBinary(self.connectionId, raw);
            }, 5);
            return;
        }
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (!msg || typeof msg.seq === 'undefined') {
            return;
        }
        setTimeout(function () {
            var data;
            if (msg.action === 'ping') {
                data = {text: 'pong', version: window.DemoServer.serverVersion(), server_time: Date.now(), node_id: ''};
            } else {
                data = window.DemoServer.onSocketAction(msg.action, msg.data || {}, self.connectionId) || {};
            }
            self._send({status: 'OK', seq_reply: msg.seq, data: data});
        }, 5);
    };

    FakeSocket.prototype.close = function (code, reason) {
        var self = this;
        if (this.readyState >= 2) {
            return;
        }
        this.readyState = 2;
        sockets = sockets.filter(function (s) {
            return s !== self;
        });
        setTimeout(function () {
            self.readyState = 3;
            self._dispatch('close', {type: 'close', code: code || 1000, reason: reason || '', wasClean: true});
        }, 5);
    };

    function isAppSocket(url) {
        try {
            // The app may add the default port to the address (wss://host:443/...): the path tells it.
            var u = new URL(String(url), location.href);
            return /\/api\/v4\/websocket$/.test(u.pathname) && (u.hostname === location.hostname || u.hostname === 'localhost');
        } catch (e) {
            return false;
        }
    }

    function DemoWebSocket(url, protocols) {
        if (isAppSocket(url)) {
            return new FakeSocket(url);
        }
        return protocols === undefined ? new RealWebSocket(url) : new RealWebSocket(url, protocols);
    }
    DemoWebSocket.prototype = RealWebSocket.prototype;
    DemoWebSocket.CONNECTING = 0;
    DemoWebSocket.OPEN = 1;
    DemoWebSocket.CLOSING = 2;
    DemoWebSocket.CLOSED = 3;
    window.WebSocket = DemoWebSocket;

    // DemoSocket.broadcast sends an event to every open app socket, or only to one connection
    // (broadcast.connection_id): {event, data, broadcast}.
    window.DemoSocket = {
        broadcast: function (msg) {
            var only = msg.broadcast && msg.broadcast.connection_id;
            sockets.slice().forEach(function (s) {
                if (!only || s.connectionId === only) {
                    s._event(JSON.parse(JSON.stringify(msg)));
                }
            });
        },
        count: function () {
            return sockets.length;
        },
    };
}());
