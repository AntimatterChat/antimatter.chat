# antimatter.chat
The antimatter.chat website: docs, downloads and news for Antimatter, a self-hosted open-source team chat.

## The demo

[antimatter.chat/demo](https://antimatter.chat/demo/) runs the real Antimatter web app (Fusion) and its default
apps in the browser, with the "Lumen Labs" sample data and no server: a service worker hands the app's requests to a
mock server in the page, which answers from recorded fixtures and keeps what visitors do in memory until they reload.

| Path | What it is |
|---|---|
| `src/demo/mock/` | The mock layer: `server.js` (the REST API), `plugins.js` (the apps' routes, and a Calls server where the visitor is alone in the call), `media.js` (a silent microphone, a black camera and a stand-in for WebRTC, so calls never touch the visitor's devices or the network), `socket.js` (a fake websocket), `life.js` (people typing, coming and going, answering direct messages), `boot.js` and `loader.js` (start-up), the banner (the app's own announcement bar) and the demo's strings in the site's languages (`i18n.json`) |
| `src/demo/sw.js`, `src/demo/loader.html` | The service worker, and the page that installs it (`/demo/`) |
| `src/demo/fixtures/` | The recorded data, cleaned of anything private, with its images |
| `tools/demo/` | `record_fixtures.py` (records the fixtures), `build_demo.py` (assembles `demo/`), `serve.py` (a local preview that behaves like GitHub Pages), `test_fixtures.py` and `smoke_mock.js` (checks) |

`demo/` itself is not committed: the Pages workflow (`.github/workflows/static.yml`) builds it at each deployment,
from the web app and app bundles of the published `ghcr.io/antimatterchat/antimatter-next` image. Besides pushes, the
workflow runs every three hours and deploys again when that image has changed, so the demo follows the app's
changes on its own. A registry failure never blocks the site: the demo is then built from the last image the
workflow cached, or, without one, `/demo/` says (in the visitor's language) that it is being updated, and the next
scheduled run builds it again.

**Refreshing the fixtures** (when the sample data changes, or the app needs data it lacks), from a local server with
the Lumen Labs data:

    DEMO_PASSWORD=... python3 tools/demo/record_fixtures.py --server http://localhost:8067 --user maya
    python3 tools/demo/test_fixtures.py && node tools/demo/smoke_mock.js

The recorder moves e-mail addresses to `@lumenlabs.example`, moves the sample company's links to reserved
`*.example` names (`git.lumenlabs.example`...), replaces the server's address, empties secret-looking keys and
private addresses, and refuses to write anything the checks reject (they also refuse any link to a real-looking
domain other than Antimatter's own). Look at the diff, then commit
`src/demo/fixtures/`. Playbooks and Kanban are not part of the demo: the recorder leaves out their data, bots and
commands (`DROPPED_APPS` in `tools/demo/test_fixtures.py`), and `record_fixtures.py --prune` takes them out of
fixtures already there.

**Trying it locally:** `python3 tools/demo/build_demo.py --image ghcr.io/antimatterchat/antimatter-next:latest`, or
with a local build, `--fusion <server repo>/webapp/fusion/dist --plugins <folder of plugin .tar.gz>`; then serve
the site with `python3 tools/demo/serve.py 8000` and open http://127.0.0.1:8000/demo/. Unlike a plain
`python3 -m http.server`, it answers missing paths with the site's 404 page, as GitHub Pages does: a hard reload or a
first visit of one of the demo's routes needs it to get back to the demo. Add `?demo-debug=1` to log, in the
console, the requests the mock answers with an empty default (also listed in `window.__demoMisses`).

## Feedback and support

Found a bug in the website, or missing a feature? Please [open an
issue](https://github.com/AntimatterChat/community/issues/new/choose) in the [Antimatter community
repository](https://github.com/AntimatterChat/community), where the feedback for every part of
Antimatter is gathered. Questions and ideas are welcome in its
[Discussions](https://github.com/AntimatterChat/community/discussions). Please report security
problems privately, as explained in the [security
policy](https://github.com/AntimatterChat/.github/blob/main/SECURITY.md).
