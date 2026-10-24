#!/usr/bin/env python3
"""Assembles the interactive demo under demo/: the real Fusion web app and the default apps' web bundles, running
in the browser against a mock server (src/demo/mock/) that answers from recorded fixtures (src/demo/fixtures/).

    python3 tools/demo/build_demo.py --image ghcr.io/antimatterchat/antimatter-next:latest
        Fusion and the apps from a published image (what the Pages workflow does). Only the image's layer holding
        /antimatter is downloaded, and its files are kept in the cache (--cache) by image digest.
    python3 tools/demo/build_demo.py --fusion ../antimatter/webapp/fusion/dist --plugins ~/Projects/rematter/amdev/plugins
        A local Fusion build (npm run build in webapp/fusion) and a folder of plugin bundles (*.tar.gz).
    python3 tools/demo/build_demo.py --digest ghcr.io/antimatterchat/antimatter-next:latest
        Prints the image's digest, to tell whether the demo needs rebuilding.
    python3 tools/demo/build_demo.py --from-cache
        Fusion and the apps of the last image read into the cache (the Pages workflow's fallback when the registry
        can't be reached).
    python3 tools/demo/build_demo.py --placeholder
        Only a page saying the demo is being updated (the fallback when there is nothing to build from).

The output (demo/, ignored by git) is built again by the Pages workflow at each deployment. To try it locally,
serve the site's root (python3 -m http.server 8000) and open http://localhost:8000/demo/.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / 'src' / 'demo'
DEFAULT_OUT = ROOT / 'demo'
DEFAULT_CACHE = pathlib.Path(os.environ.get('XDG_CACHE_HOME', pathlib.Path.home() / '.cache')) / 'antimatter-demo'

# The apps shown in the demo: the default apps of the antimatter-next image that work without an outside service.
# Not included: the AI agents (they need a language model), Mail (an IMAP server) and Calendar, GitHub, GitLab,
# Jira and Metrics (outside services), and Playbooks and Kanban, left out of the demo since 2026-10-23 (their data
# too: see DROPPED_APPS in test_fixtures.py). Calls runs against the mock's own Calls server, with no media server
# and no camera or microphone (mock/media.js).
PLUGINS = [
    'com.antimatterchat.notes',
    'com.antimatterchat.polls',
    'com.mattermost.plugin-todo',
    'com.antimatterchat.whiteboard',
    'com.mattermost.calls',
    'memes',
    'com.antimatterchat.gifs',
    'com.antimatterchat.voice-channels',
]

# Apps not (yet) in the antimatter-next image: their web bundles are committed here (<id>-<version>.tar.gz, refreshed
# with tools/demo/refresh_extra_apps.sh) until the app has GitHub releases, when they'll be fetched from there
# instead. Added next to the image's apps, same bundle format.
EXTRA_APPS = [
    'com.antimatterchat.assistant',
]
EXTRA_APPS_DIR = SRC / 'extra-apps'

# Files of the web bundles the demo never loads.
SKIP = re.compile(r'(\.map$|(^|/)tests?/|\.LICENSE\.txt\.map$)')
# And per app (by plugin id), more of them.
APP_SKIP = {}
SOURCE_MAP_COMMENT = re.compile(rb'\n?//# sourceMappingURL=[^\n]*\s*$|/\*# sourceMappingURL=[^*]*\*/\s*$')

INDEX_TYPES = ('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json')
MANIFEST_TYPES = ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json')


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# --- The image, read straight from its registry (no Docker needed) ----------------------------------------------

class Registry:
    def __init__(self, ref):
        m = re.match(r'^([^/]+)/(.+?)(?::([^:/@]+))?(?:@(sha256:[0-9a-f]+))?$', ref)
        if not m:
            raise SystemExit(f'not an image reference: {ref}')
        self.host, self.repo = m.group(1), m.group(2)
        self.tag = m.group(4) or m.group(3) or 'latest'
        self.token = None

    def _open(self, path, accept=None):
        if self.token is None:
            url = f'https://{self.host}/token?scope=repository:{self.repo}:pull&service={self.host}'
            with urllib.request.urlopen(url, timeout=60) as r:
                self.token = json.load(r).get('token', '')
        req = urllib.request.Request(f'https://{self.host}/v2/{self.repo}/{path}')
        # Not sent on to the blob storage the registry redirects to.
        req.add_unredirected_header('Authorization', f'Bearer {self.token}')
        if accept:
            req.add_header('Accept', ', '.join(accept))
        return urllib.request.urlopen(req, timeout=300)

    def manifest(self):
        """The linux/amd64 image manifest and its digest."""
        with self._open(f'manifests/{self.tag}', INDEX_TYPES + MANIFEST_TYPES) as r:
            digest = r.headers.get('Docker-Content-Digest', '')
            doc = json.load(r)
        if doc.get('mediaType') in INDEX_TYPES or 'manifests' in doc:
            pick = next((m for m in doc['manifests']
                         if m.get('platform', {}).get('os') == 'linux' and m['platform'].get('architecture') == 'amd64'),
                        None)
            if not pick:
                raise SystemExit('the image has no linux/amd64 variant')
            digest = pick['digest']
            with self._open(f'manifests/{digest}', MANIFEST_TYPES) as r:
                doc = json.load(r)
        return digest, doc

    def blob(self, digest):
        return self._open(f'blobs/{digest}')


def image_digest(ref):
    return Registry(ref).manifest()[0]


def fetch_image(ref, cache):
    """Extracts /antimatter/client-fusion and /antimatter/prepackaged_plugins from the image into the cache, once per
    image digest. Returns (fusion dir, plugins dir, details)."""
    reg = Registry(ref)
    digest, manifest = reg.manifest()
    dest = cache / digest.replace(':', '-')
    done = dest / '.complete'
    if done.exists():
        log(f'image {ref} ({digest[:19]}): cached in {dest}')
        return dest / 'client-fusion', dest / 'prepackaged_plugins', json.loads(done.read_text())
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    details = {'image': ref, 'digest': digest}
    try:
        with reg.blob(manifest['config']['digest']) as r:
            labels = (json.load(r).get('config') or {}).get('Labels') or {}
        details['labels'] = {k: v for k, v in labels.items() if k.startswith('org.opencontainers.')}
    except (urllib.error.URLError, KeyError, ValueError):
        pass
    wanted = re.compile(r'^/?antimatter/(client-fusion/.+|prepackaged_plugins/[^/]+\.tar\.gz)$')
    # /antimatter is copied in by one of the last layers: read them from the top, and stop at the one that has it.
    for layer in reversed(manifest['layers']):
        if 'gzip' not in layer.get('mediaType', 'gzip'):
            log(f'skipping a layer in {layer.get("mediaType")}')
            continue
        size = layer.get('size', 0)
        log(f'reading layer {layer["digest"][:19]} ({size / 1e6:.0f} MB)')
        found = 0
        with reg.blob(layer['digest']) as r, tarfile.open(fileobj=r, mode='r|gz') as tar:
            for member in tar:
                m = wanted.match(member.name)
                if not m or not member.isfile():
                    continue
                out = dest / m.group(1)
                out.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as f, open(out, 'wb') as w:
                    shutil.copyfileobj(f, w)
                found += 1
        if found:
            log(f'  {found} files')
            break
    if not (dest / 'client-fusion' / 'root.html').exists():
        raise SystemExit(f'{ref} has no /antimatter/client-fusion/root.html')
    done.write_text(json.dumps(details))
    # Only this image is kept: the cache holds the last image read, for --from-cache.
    for other in cache.iterdir():
        if other.is_dir() and other != dest:
            shutil.rmtree(other, ignore_errors=True)
    return dest / 'client-fusion', dest / 'prepackaged_plugins', details


def cached_image(cache):
    """The image last read into the cache: (fusion dir, plugins dir, details), or None."""
    found = sorted((d for d in cache.glob('sha256-*') if (d / '.complete').exists()),
                   key=lambda d: (d / '.complete').stat().st_mtime, reverse=True) if cache.exists() else []
    if not found:
        return None
    d = found[0]
    details = json.loads((d / '.complete').read_text())
    details['from_cache'] = True
    log(f'using the cached image {details.get("image")} ({details.get("digest", "")[:19]})')
    return d / 'client-fusion', d / 'prepackaged_plugins', details


# --- Assembling the demo ---------------------------------------------------------------------------------------

def copy_file(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.suffix in ('.js', '.css'):
        data = src.read_bytes()
        stripped = SOURCE_MAP_COMMENT.sub(b'', data)
        dst.write_bytes(stripped)
    else:
        shutil.copyfile(src, dst)


def rewrite_subpath(text, base):
    """What the server does for a site URL with a path (server/channels/utils/subpath.go): /static/ becomes
    <base>static/ in root.html, manifest.json and the style sheets."""
    return text.replace('/static/', base + 'static/')


def copy_fusion(dist, out, base):
    if not (dist / 'root.html').exists():
        raise SystemExit(f'{dist} is not a Fusion build (no root.html): run npm run build in webapp/fusion')
    target = out / 'static' / 'fusion'
    n = 0
    for f in sorted(dist.rglob('*')):
        rel = f.relative_to(dist).as_posix()
        if not f.is_file() or SKIP.search(rel) or rel == 'root.html':
            continue
        dst = target / rel
        if f.suffix == '.css' or f.name == 'manifest.json':
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(rewrite_subpath(SOURCE_MAP_COMMENT.sub(b'', f.read_bytes()).decode('utf-8'), base))
        else:
            copy_file(f, dst)
        n += 1
    log(f'fusion: {n} files from {dist}')
    return (dist / 'root.html').read_text()


def app_page(root_html, base, version):
    """app.html: Fusion's root.html for the demo's subpath, with the app's scripts started by the mock layer once it
    is ready instead of by the page."""
    html = rewrite_subpath(root_html, base)
    scripts = re.findall(r'<script src="([^"]+)"></script>', html)
    html = re.sub(r'<script src="[^"]+"></script>', '', html)
    app = [s for s in scripts if '/remote_entry.js' not in s]  # The module federation entry is the desktop app's.
    if not any('/main.' in s for s in app):
        raise SystemExit('root.html has no main script')
    # The favicons of root.html come from the classic web app's folder, which the demo doesn't have: they show the
    # site's icon until the app sets its own. The tags stay, one per size: the app looks them up to update them
    # (unread and mention badges) and stops if one is missing.
    html = re.sub(r'(<link rel="icon") type="image/png" href="[^"]*"', r'\1 type="image/svg+xml" href="/favicon.svg"', html)
    html = html.replace('<script id="publicPathInWindowScript"></script>', '')
    v = f'?v={version}'
    mock = (f'<link rel="stylesheet" href="{base}mock/banner.css{v}">'
            f'<script src="{base}mock/media.js{v}"></script>'
            f'<script src="{base}mock/server.js{v}"></script>'
            f'<script src="{base}mock/plugins.js{v}"></script>'
            f'<script src="{base}mock/assistant.js{v}"></script>'
            f'<script src="{base}mock/socket.js{v}"></script>'
            f'<script src="{base}mock/life.js{v}"></script>'
            f'<script src="{base}mock/boot.js{v}" id="demo-boot" data-base="{base}" data-version="{version}" '
            f"data-app='{json.dumps(app)}'></script>")
    # The mock layer goes first in <head>, before the style sheets and the Content-Security-Policy (script-src
    # 'self': every script is a file of the site, none inline).
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + mock, 1)
    html = html.replace('<title>Antimatter</title>', '<title>Antimatter demo</title>', 1)
    return html


def read_plugin_tarball(tgz, out, allowed=None):
    """Extracts one plugin tarball's web bundle (its manifest's webapp.bundle_path, flattened to main.js) into
    out/static/plugins/<id>, as the demo serves it. Returns (id, {version_key, manifest, files, tarball}), or None
    when the tarball has no plugin.json, no webapp bundle, or (with allowed given) isn't one of its ids."""
    with tarfile.open(tgz) as tar:
        names = tar.getnames()
        mf = next((n for n in names if re.match(r'^[^/]+/plugin\.json$', n)), None)
        if not mf:
            return None
        manifest = json.load(tar.extractfile(mf))
        pid = manifest.get('id')
        if (allowed is not None and pid not in allowed) or not manifest.get('webapp'):
            return None
        top = mf.split('/')[0]
        target = out / 'static' / 'plugins' / pid
        if target.exists():
            shutil.rmtree(target)
        files = 0
        bundle = None
        for member in tar.getmembers():
            prefix = f'{top}/webapp/dist/'
            if not member.isfile() or not member.name.startswith(prefix):
                continue
            rel = member.name[len(prefix):]
            if SKIP.search(rel) or (pid in APP_SKIP and APP_SKIP[pid].search(rel)):
                continue
            data = tar.extractfile(member).read()
            if rel.endswith(('.js', '.css')):
                data = SOURCE_MAP_COMMENT.sub(b'', data)
            if rel == 'main.js':
                bundle = f'{pid}_{hashlib.sha256(data).hexdigest()[:16]}_bundle.js'
                rel = bundle
            dst = target / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            files += 1
        if not bundle:
            return None
        webapp = {'bundle_path': f'/static/{pid}/{bundle}'}
        return pid, {
            'version_key': version_key(manifest.get('version', '')),
            'manifest': {k: v for k, v in manifest.items() if k not in ('server', 'settings_schema', 'props')} | {'webapp': webapp},
            'files': files,
            'tarball': tgz.name,
        }


def plugin_bundles(plugins_dir, out):
    """Copies the web bundles of the demo's apps (PLUGINS) from their tarballs, and returns their manifests as the
    server lists them (GET /api/v4/plugins/webapp)."""
    found = {}
    for tgz in sorted(plugins_dir.glob('*.tar.gz')):
        entry = read_plugin_tarball(tgz, out, allowed=PLUGINS)
        if not entry:
            continue
        pid, data = entry
        if pid in found and found[pid]['version_key'] >= data['version_key']:
            continue
        found[pid] = data
    for pid in PLUGINS:
        if pid in found:
            log(f'app {pid} {found[pid]["manifest"].get("version")}: {found[pid]["files"]} files ({found[pid]["tarball"]})')
        else:
            log(f'warning: no web bundle for {pid} in {plugins_dir}')
    return [found[p]['manifest'] for p in PLUGINS if p in found]


def extra_app_bundles(out):
    """Apps not in the antimatter-next image yet (EXTRA_APPS): web bundles committed in src/demo/extra-apps/
    (<id>-<version>.tar.gz, kept current with tools/demo/refresh_extra_apps.sh). Added next to the image's apps.
    Once an app has GitHub releases, this is where fetching its latest release would go instead."""
    found = {}
    if EXTRA_APPS_DIR.exists():
        for tgz in sorted(EXTRA_APPS_DIR.glob('*.tar.gz')):
            entry = read_plugin_tarball(tgz, out, allowed=EXTRA_APPS)
            if not entry:
                continue
            pid, data = entry
            if pid in found and found[pid]['version_key'] >= data['version_key']:
                continue
            found[pid] = data
    for pid in EXTRA_APPS:
        if pid in found:
            log(f'extra app {pid} {found[pid]["manifest"].get("version")}: {found[pid]["files"]} files ({found[pid]["tarball"]})')
        else:
            log(f'note: no bundle for the extra app {pid} in {EXTRA_APPS_DIR} (skipped)')
    return [found[p]['manifest'] for p in EXTRA_APPS if p in found]


def version_key(v):
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r'[.+-]', v)[:3])


def copy_tree(src, dst):
    for f in sorted(src.rglob('*')):
        if f.is_file() and not f.name.startswith('.'):
            target = dst / f.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, target)


def placeholder(out, base):
    """demo/ when it can't be built: the loader page, saying in the visitor's language that the demo is being
    updated. Its build.json has no digest, so the next scheduled deployment builds the demo again."""
    if out.exists():
        shutil.rmtree(out)
    (out / 'mock').mkdir(parents=True)
    version = 'updating-' + time.strftime('%Y%m%d%H%M', time.gmtime())
    for name in ('loader.js', 'banner.css', 'i18n.json'):
        shutil.copyfile(SRC / 'mock' / name, out / 'mock' / name)
    page = (SRC / 'loader.html').read_text().replace('{{base}}', base).replace('{{version}}', version).replace(
        '{{mode}}', 'updating')
    (out / 'index.html').write_text(page)
    (out / 'build.json').write_text(json.dumps({'version': version, 'placeholder': True,
                                                'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                                'source': {}}, indent=1) + '\n')
    log(f'demo placeholder written to {out}')


def size_of(path):
    return sum(f.stat().st_size for f in path.rglob('*') if f.is_file())


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--image', help='take Fusion and the apps from this image')
    p.add_argument('--fusion', type=pathlib.Path, help='a Fusion build (webapp/fusion/dist)')
    p.add_argument('--plugins', type=pathlib.Path, help='a folder of plugin bundles (*.tar.gz)')
    p.add_argument('--out', type=pathlib.Path, default=DEFAULT_OUT)
    p.add_argument('--base', default='/demo/', help='the path the demo is served at')
    p.add_argument('--cache', type=pathlib.Path, default=DEFAULT_CACHE)
    p.add_argument('--digest', metavar='IMAGE', help="print the image's digest and exit")
    p.add_argument('--from-cache', action='store_true', help='use the image last read into the cache')
    p.add_argument('--placeholder', action='store_true', help='only write a page saying the demo is being updated')
    args = p.parse_args()

    if args.digest:
        print(image_digest(args.digest))
        return
    base = '/' + args.base.strip('/') + '/'
    if args.placeholder:
        placeholder(args.out, base)
        return
    details = {}
    if args.from_cache:
        found = cached_image(args.cache)
        if not found:
            raise SystemExit(f'no image in the cache ({args.cache})')
        fusion, plugins, details = found
    elif args.image:
        fusion, plugins, details = fetch_image(args.image, args.cache)
        fusion = args.fusion or fusion
        plugins = args.plugins or plugins
    elif args.fusion and args.plugins:
        fusion, plugins = args.fusion, args.plugins
        details = {'fusion': str(fusion.resolve()), 'plugins': str(plugins.resolve())}
    else:
        p.error('give --image, --from-cache, or --fusion and --plugins')

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    root_html = copy_fusion(fusion, out, base)
    manifests = plugin_bundles(plugins, out) + extra_app_bundles(out)

    copy_tree(SRC / 'mock', out / 'mock')
    copy_tree(SRC / 'fixtures', out / 'fixtures')
    (out / 'fixtures' / 'plugins_webapp.json').write_text(json.dumps(manifests, indent=1))

    # One version for the files whose names don't change (mock/, fixtures/, app.html), so a new demo never mixes with
    # what a browser cached from the previous one.
    h = hashlib.sha256()
    for f in sorted(list((out / 'mock').rglob('*')) + list((out / 'fixtures').rglob('*.json'))):
        if f.is_file():
            h.update(f.read_bytes())
    h.update(root_html.encode())
    version = h.hexdigest()[:12]

    (out / 'app.html').write_text(app_page(root_html, base, version))
    loader = (SRC / 'loader.html').read_text().replace('{{base}}', base).replace('{{version}}', version).replace(
        '{{mode}}', 'start')
    (out / 'index.html').write_text(loader)
    shutil.copyfile(SRC / 'sw.js', out / 'sw.js')

    build = {
        'version': version,
        'built_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': details,
        'apps': {m['id']: m.get('version') for m in manifests},
    }
    (out / 'build.json').write_text(json.dumps(build, indent=1) + '\n')
    total = size_of(out)
    fusion_size = size_of(out / 'static' / 'fusion')
    apps_size = size_of(out / 'static' / 'plugins') if (out / 'static' / 'plugins').exists() else 0
    log(f'demo {version}: {total / 1e6:.1f} MB in {out} (Fusion {fusion_size / 1e6:.1f} MB, apps {apps_size / 1e6:.1f} MB, '
        f'fixtures {size_of(out / "fixtures") / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
