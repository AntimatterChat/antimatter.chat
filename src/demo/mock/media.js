// The demo's camera, microphone and call connection: nothing real. Calls (the Calls app, through voice channels or
// the call button) asks the browser for the microphone and the camera, and connects to a media server over WebRTC.
// The demo has no media server and never touches the visitor's devices: getUserMedia and getDisplayMedia give a
// silent microphone and a black camera or screen, made in the page (so the browser never asks for permission), the
// device lists name only those, and RTCPeerConnection is a stand-in that "connects" once the mock's Calls server
// (mock/plugins.js) answers its offer. Nothing leaves the page.
(function () {
    'use strict';

    var DEVICES = [
        {deviceId: 'demo-microphone', groupId: 'demo', kind: 'audioinput', label: 'Demo microphone (silent)'},
        {deviceId: 'demo-speaker', groupId: 'demo', kind: 'audiooutput', label: 'Demo speaker'},
        {deviceId: 'demo-camera', groupId: 'demo', kind: 'videoinput', label: 'Demo camera (black)'},
    ];

    // --- tracks -------------------------------------------------------------------------------------------------

    var audioContext = null;

    function silentAudioTrack() {
        try {
            audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
            // Nothing is connected to the destination: its track carries silence.
            var track = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
            return decorate(track, 'demo-microphone', 'Demo microphone (silent)');
        } catch (e) {
            return null;
        }
    }

    function blackVideoTrack(label, deviceId, width, height) {
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        function paint() {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, width, height);
        }
        paint();
        var stream = canvas.captureStream ? canvas.captureStream(5) : null;
        var track = stream && stream.getVideoTracks()[0];
        if (!track) {
            return null;
        }
        // A canvas stream only sends frames when it is drawn on.
        var timer = setInterval(paint, 500);
        track.addEventListener('ended', function () {
            clearInterval(timer);
        });
        var stop = track.stop.bind(track);
        track.stop = function () {
            clearInterval(timer);
            stop();
        };
        return decorate(track, deviceId, label, {width: width, height: height, frameRate: 5});
    }

    // decorate makes a made-up track look like a device's: its label and settings name the demo device.
    function decorate(track, deviceId, label, extra) {
        var settings = track.getSettings ? track.getSettings() : {};
        try {
            Object.defineProperty(track, 'label', {value: label});
        } catch (e) {
            // Read-only in this browser: the label stays empty.
        }
        track.getSettings = function () {
            return Object.assign({}, settings, extra || {}, {deviceId: deviceId, groupId: 'demo'});
        };
        track.applyConstraints = function () {
            return Promise.resolve();
        };
        return track;
    }

    function fakeStream(constraints, screen) {
        var tracks = [];
        var c = constraints || {};
        if (c.audio && !screen) {
            var a = silentAudioTrack();
            if (a) {
                tracks.push(a);
            }
        }
        if (c.video || screen) {
            var v = screen ? blackVideoTrack('Demo screen', 'demo-screen', 1280, 720) : blackVideoTrack('Demo camera (black)', 'demo-camera', 640, 360);
            if (v) {
                tracks.push(v);
            }
        }
        if (!tracks.length) {
            var err = new Error('Requested device not found');
            err.name = 'NotFoundError';
            return Promise.reject(err);
        }
        return Promise.resolve(new MediaStream(tracks));
    }

    var md = navigator.mediaDevices;
    if (md) {
        var override = function (name, fn) {
            try {
                Object.defineProperty(md, name, {value: fn, configurable: true, writable: true});
            } catch (e) {
                md[name] = fn;
            }
        };
        override('getUserMedia', function (constraints) {
            return fakeStream(constraints, false);
        });
        override('getDisplayMedia', function () {
            return fakeStream({video: true}, true);
        });
        override('enumerateDevices', function () {
            return Promise.resolve(DEVICES.map(function (d) {
                return Object.assign({toJSON: function () {
                    return {deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label};
                }}, d);
            }));
        });
    }
    // The old callback API, for completeness.
    navigator.getUserMedia = function (constraints, ok, fail) {
        fakeStream(constraints, false).then(ok, fail);
    };

    // The permissions the demo's devices need are always given: there is nothing to ask.
    if (navigator.permissions && navigator.permissions.query) {
        var query = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = function (desc) {
            var name = desc && desc.name;
            if (name === 'camera' || name === 'microphone' || name === 'speaker-selection') {
                return Promise.resolve({name: name, state: 'granted', onchange: null, addEventListener: function () {},
                    removeEventListener: function () {}});
            }
            return query(desc);
        };
    }

    // --- the connection -------------------------------------------------------------------------------------------

    function Emitter() {}
    Emitter.prototype.addEventListener = function (type, fn) {
        this._l = this._l || {};
        (this._l[type] = this._l[type] || []).push(fn);
    };
    Emitter.prototype.removeEventListener = function (type, fn) {
        if (this._l && this._l[type]) {
            this._l[type] = this._l[type].filter(function (f) {
                return f !== fn;
            });
        }
    };
    Emitter.prototype.dispatchEvent = function (ev) {
        var self = this;
        var handler = this['on' + ev.type];
        if (typeof handler === 'function') {
            handler.call(this, ev);
        }
        ((this._l || {})[ev.type] || []).slice().forEach(function (fn) {
            fn.call(self, ev);
        });
        return true;
    };
    Emitter.prototype._fire = function (type, extra) {
        var ev = Object.assign({type: type, target: this}, extra || {});
        this.dispatchEvent(ev);
    };

    var SDP_TEXT = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=antimatter-demo', 't=0 0', 'a=group:BUNDLE 0',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sctp-port:5000', ''].join('\r\n');

    function description(type) {
        return {type: type, sdp: SDP_TEXT, toJSON: function () {
            return {type: type, sdp: SDP_TEXT};
        }};
    }

    // The data channel answers what the calls client sends on it the way the media server does: a pong to each ping,
    // and the signalling lock it asks for before adding or removing a track (messages in MessagePack: a type number,
    // then the payload; Ping 1, Pong 2, Lock 7 answered with true).
    function FakeDataChannel(label, pc) {
        this.label = label;
        this.readyState = 'connecting';
        this.binaryType = 'arraybuffer';
        this.bufferedAmount = 0;
        this.bufferedAmountLowThreshold = 0;
        this.ordered = true;
        this.protocol = '';
        this.id = 0;
        this._pc = pc;
    }
    FakeDataChannel.prototype = Object.create(Emitter.prototype);
    FakeDataChannel.prototype._open = function () {
        if (this.readyState === 'connecting') {
            this.readyState = 'open';
            this._fire('open');
        }
    };
    FakeDataChannel.prototype.send = function (data) {
        if (this.readyState !== 'open') {
            var err = new Error('RTCDataChannel.readyState is not \'open\'');
            err.name = 'InvalidStateError';
            throw err;
        }
        var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (!bytes || !bytes.length) {
            return;
        }
        var reply = null;
        if (bytes[0] === 1) {
            reply = [2];
        } else if (bytes[0] === 7) {
            reply = [7, 0xc3];
        }
        if (reply) {
            var self = this;
            setTimeout(function () {
                if (self.readyState === 'open') {
                    self._fire('message', {data: new Uint8Array(reply).buffer});
                }
            }, 5);
        }
    };
    FakeDataChannel.prototype.close = function () {
        if (this.readyState === 'closed') {
            return;
        }
        this.readyState = 'closed';
        this._fire('close');
    };

    function FakeSender(track) {
        this.track = track || null;
        this.transport = null;
        this.dtmf = null;
        this._params = {encodings: [{active: true}], transactionId: 'demo', codecs: [], headerExtensions: [], rtcp: {}};
    }
    FakeSender.prototype.replaceTrack = function (track) {
        this.track = track || null;
        return Promise.resolve();
    };
    FakeSender.prototype.getParameters = function () {
        return JSON.parse(JSON.stringify(this._params));
    };
    FakeSender.prototype.setParameters = function (p) {
        this._params = p || this._params;
        return Promise.resolve();
    };
    FakeSender.prototype.getStats = function () {
        return Promise.resolve(new Map());
    };
    FakeSender.prototype.setStreams = function () {};

    function FakeReceiver(kind) {
        this.track = null;
        this._kind = kind;
    }
    FakeReceiver.prototype.getStats = function () {
        return Promise.resolve(new Map());
    };
    FakeReceiver.prototype.getParameters = function () {
        return {codecs: [], headerExtensions: [], rtcp: {}};
    };
    FakeReceiver.prototype.getSynchronizationSources = function () {
        return [];
    };
    FakeReceiver.prototype.getContributingSources = function () {
        return [];
    };

    var pcs = [];

    function FakePeerConnection(config) {
        this._config = config || {};
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
        this.currentLocalDescription = null;
        this.currentRemoteDescription = null;
        this.pendingLocalDescription = null;
        this.pendingRemoteDescription = null;
        this.canTrickleIceCandidates = true;
        this.sctp = null;
        this._transceivers = [];
        this._channels = [];
        this._mid = 1; // mid 0 is the data channel's.
        this._negotiation = false;
        pcs.push(this);
    }
    FakePeerConnection.prototype = Object.create(Emitter.prototype);
    FakePeerConnection.generateCertificate = function () {
        return Promise.resolve({expires: Date.now() + 864e5, getFingerprints: function () {
            return [];
        }});
    };

    FakePeerConnection.prototype._needNegotiation = function () {
        var self = this;
        if (this._negotiation || this.signalingState === 'closed') {
            return;
        }
        this._negotiation = true;
        setTimeout(function () {
            self._negotiation = false;
            if (self.signalingState === 'stable') {
                self._fire('negotiationneeded');
            }
        }, 0);
    };
    FakePeerConnection.prototype._setState = function (name, value, event) {
        if (this[name] === value) {
            return;
        }
        this[name] = value;
        this._fire(event);
    };
    // _connect: what a real connection goes through once both sides have a description.
    FakePeerConnection.prototype._connect = function () {
        var self = this;
        if (this.connectionState !== 'new') {
            return;
        }
        this._setState('iceGatheringState', 'complete', 'icegatheringstatechange');
        this._setState('iceConnectionState', 'checking', 'iceconnectionstatechange');
        this._setState('connectionState', 'connecting', 'connectionstatechange');
        setTimeout(function () {
            if (self.signalingState === 'closed') {
                return;
            }
            self._setState('iceConnectionState', 'connected', 'iceconnectionstatechange');
            self._setState('connectionState', 'connected', 'connectionstatechange');
            self._channels.forEach(function (dc) {
                dc._open();
            });
        }, 150);
    };

    FakePeerConnection.prototype.createDataChannel = function (label) {
        var dc = new FakeDataChannel(label, this);
        this._channels.push(dc);
        if (this.connectionState === 'connected') {
            setTimeout(function () {
                dc._open();
            }, 0);
        }
        this._needNegotiation();
        return dc;
    };
    FakePeerConnection.prototype._transceiver = function (track, kind, init) {
        var t = {
            mid: String(this._mid++),
            kind: kind,
            direction: (init && init.direction) || 'sendrecv',
            currentDirection: null,
            sender: new FakeSender(track),
            receiver: new FakeReceiver(kind),
            stopped: false,
            setCodecPreferences: function () {},
            setDirection: function (d) {
                this.direction = d;
            },
            stop: function () {
                this.stopped = true;
                this.currentDirection = 'stopped';
            },
        };
        this._transceivers.push(t);
        this._needNegotiation();
        return t;
    };
    FakePeerConnection.prototype.addTrack = function (track) {
        return this._transceiver(track, track && track.kind, null).sender;
    };
    FakePeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
        var track = typeof trackOrKind === 'string' ? null : trackOrKind;
        return this._transceiver(track, track ? track.kind : trackOrKind, init);
    };
    FakePeerConnection.prototype.removeTrack = function (sender) {
        this._transceivers.forEach(function (t) {
            if (t.sender === sender) {
                t.sender.track = null;
                t.direction = 'recvonly';
            }
        });
        this._needNegotiation();
    };
    FakePeerConnection.prototype.getSenders = function () {
        return this._transceivers.map(function (t) {
            return t.sender;
        });
    };
    FakePeerConnection.prototype.getReceivers = function () {
        return this._transceivers.map(function (t) {
            return t.receiver;
        });
    };
    FakePeerConnection.prototype.getTransceivers = function () {
        return this._transceivers.slice();
    };
    FakePeerConnection.prototype.createOffer = function () {
        return Promise.resolve(description('offer'));
    };
    FakePeerConnection.prototype.createAnswer = function () {
        return Promise.resolve(description('answer'));
    };
    FakePeerConnection.prototype.setLocalDescription = function (desc) {
        if (this.signalingState === 'closed') {
            return Promise.reject(new Error('The RTCPeerConnection is closed.'));
        }
        var type = (desc && desc.type) || (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
        this.localDescription = description(type);
        if (type === 'offer') {
            this.pendingLocalDescription = this.localDescription;
            this._setState('signalingState', 'have-local-offer', 'signalingstatechange');
        } else {
            this.currentLocalDescription = this.localDescription;
            this._setState('signalingState', 'stable', 'signalingstatechange');
            this._connect();
        }
        return Promise.resolve();
    };
    FakePeerConnection.prototype.setRemoteDescription = function (desc) {
        if (this.signalingState === 'closed') {
            return Promise.reject(new Error('The RTCPeerConnection is closed.'));
        }
        var type = desc && desc.type;
        this.remoteDescription = description(type || 'answer');
        if (type === 'offer') {
            this.pendingRemoteDescription = this.remoteDescription;
            this._setState('signalingState', 'have-remote-offer', 'signalingstatechange');
        } else {
            this.currentRemoteDescription = this.remoteDescription;
            this.currentLocalDescription = this.localDescription;
            this._setState('signalingState', 'stable', 'signalingstatechange');
            this._transceivers.forEach(function (t) {
                t.currentDirection = t.direction;
            });
            this._connect();
        }
        return Promise.resolve();
    };
    FakePeerConnection.prototype.addIceCandidate = function () {
        return Promise.resolve();
    };
    FakePeerConnection.prototype.restartIce = function () {};
    FakePeerConnection.prototype.getConfiguration = function () {
        return this._config;
    };
    FakePeerConnection.prototype.setConfiguration = function (c) {
        this._config = c || {};
    };
    FakePeerConnection.prototype.getStats = function () {
        return Promise.resolve(new Map());
    };
    FakePeerConnection.prototype.close = function () {
        if (this.signalingState === 'closed') {
            return;
        }
        // As in browsers, close() fires no state change of its own.
        this.signalingState = 'closed';
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this._channels.forEach(function (dc) {
            dc.close();
        });
        this._transceivers.forEach(function (t) {
            t.stop();
        });
        var self = this;
        pcs = pcs.filter(function (p) {
            return p !== self;
        });
    };

    window.RTCPeerConnection = FakePeerConnection;
    window.webkitRTCPeerConnection = FakePeerConnection;

    window.DemoMedia = {
        devices: DEVICES,
        connections: function () {
            return pcs.length;
        },
    };
}());
