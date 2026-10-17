#!/usr/bin/env python3
"""Records the demo's fixtures from the local seeded demo server (the "Lumen Labs" seed, see the amdev demo
scripts), as the user maya: what the mock server (src/demo/mock/) needs to answer the app and its default apps.

    python3 tools/demo/record_fixtures.py                     # http://localhost:8067, maya
    python3 tools/demo/record_fixtures.py --server URL --user NAME --password-file FILE

The password is read from --password-file, the DEMO_PASSWORD environment variable, or asked for; the session token
only lives in memory and is checked to appear nowhere in the output. Everything recorded is cleaned (Cleaner):
e-mail addresses move to @lumenlabs.example, the server's address becomes __SITE__ (filled in by the mock with the
demo's own address), secret-looking keys are emptied, private addresses replaced. tools/demo/test_fixtures.py then
checks the result, and the recording is refused if it fails.

Output, in src/demo/fixtures/:
    core.json        the session: config, licence, me, teams, channels, members, categories, preferences, roles...
    users.json       people and bots, their statuses
    posts.json       every post of the channels maya can read, with their threads
    routes.json      answers replayed as they are, by method and path (Antimatter's own endpoints, the apps' routes)
    apps.json        the apps' data that the mock changes (notes, boards, polls, todos, kanban, playbooks...)
    media.json       which file answers which image URL (avatars, emoji, file previews, GIFs, memes...)
    media/           those files
"""
import argparse
import getpass
import hashlib
import json
import mimetypes
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'src' / 'demo' / 'fixtures'
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fixtures  # noqa: E402

DEMO_DOMAIN = 'lumenlabs.example'
SITE = '__SITE__'  # The server's address; the mock puts the demo's own (https://antimatter.chat/demo) in its place.
MEDIA_BASE = '__MEDIA__'  # The fixtures' media folder (/demo/fixtures/media/).
# The largest file kept as it is; bigger originals are answered with their preview.
MAX_FILE = 1_500_000
MAX_GIF_MEDIA = 6_000_000  # All GIF and sticker media together.

SECRET_KEYS = re.compile(
    r'^(token|password|passwd|secret|salt|api_?key|access_?key|private_?key|session_?id|auth_?data|mfa_?secret|'
    r'credentials?|cookie|giphysdkkey|googledeveloperkey|asymmetricsigningpublickey|cwsurl|cwsapiurl|'
    r'tenorapikey|apikey|uploadkey|clientsecret|turnserverscredentials|turnstaticauthsecret|rtcdserviceurl|'
    r'icehostoverride|serviceurl|mediaurl|pushnotificationserver|webhook_?secret|.*_token|.*_secret|.*_password)$', re.I)
KEEP_KEYS = re.compile(r'^(csrf_token_required|token_type|has_password|.*_enabled|enable.*|password_.*)$', re.I)
PRIVATE_IP = test_fixtures.PRIVATE_IP
EMAIL = re.compile(r'([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|localhost)\b')


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Server:
    def __init__(self, url, user, password):
        self.url = url.rstrip('/')
        req = urllib.request.Request(self.url + '/api/v4/users/login', method='POST',
                                     data=json.dumps({'login_id': user, 'password': password}).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            self.token = r.headers['Token']
            self.me = json.load(r)
        self.hosts = {urllib.parse.urlsplit(self.url).netloc}
        self.errors = []

    def _req(self, method, path, body=None, raw=False, headers=None):
        url = path if path.startswith('http') else self.url + path
        data = None
        h = {'X-Requested-With': 'XMLHttpRequest'}
        if url.startswith(self.url + '/'):
            h['Authorization'] = f'Bearer {self.token}'  # Never sent anywhere else.
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
        h.update(headers or {})
        req = urllib.request.Request(url, method=method, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                content = r.read()
                if raw:
                    return r.status, r.headers.get('Content-Type', ''), content
                return r.status, json.loads(content) if content.strip() else None
        except urllib.error.HTTPError as e:
            content = e.read()
            if raw:
                return e.code, e.headers.get('Content-Type', ''), content
            try:
                return e.code, json.loads(content)
            except ValueError:
                return e.code, None

    def get(self, path, quiet=False):
        status, body = self._req('GET', path)
        if status >= 400 and not quiet:
            self.errors.append(f'GET {path}: {status}')
        return body if status < 400 else None

    def post(self, path, body, quiet=False):
        status, out = self._req('POST', path, body)
        if status >= 400 and not quiet:
            self.errors.append(f'POST {path}: {status}')
        return out if status < 400 else None

    def raw(self, path, headers=None):
        status, ctype, content = self._req('GET', path, raw=True, headers=headers)
        return (ctype, content) if status < 400 else (None, None)


class Recorder:
    def __init__(self, server, out):
        self.s = server
        self.out = out
        self.routes = {}
        self.media = {}
        self.saved = {}
        self.media_bytes = 0
        self.gif_bytes = 0
        (out / 'media').mkdir(parents=True, exist_ok=True)

    # --- recording helpers

    def route(self, path, method='GET', body=None, status=None, key=None, quiet=False):
        """Records an answer replayed as it is."""
        if method == 'GET':
            value = self.s.get(path, quiet=quiet)
        else:
            value = self.s.post(path, body, quiet=quiet)
        if value is None and status is None:
            return None
        self.routes[key or f'{method} {path}'] = value if status is None else {'__status': status, 'body': value}
        return value

    def save_media(self, url_path, kind, name=None, headers=None, limit=MAX_FILE, budget=None, record=True):
        """Downloads an image or file of the server and records which file answers its URL (unless record is False:
        then the caller points to the file itself). Returns the media path."""
        if url_path in self.media:
            return self.media[url_path]
        if url_path in self.saved:
            return self.saved[url_path]
        ctype, content = self.s.raw(url_path, headers=headers)
        if content is None:
            return None
        if len(content) > limit:
            log(f'  skipped {url_path}: {len(content) / 1e6:.1f} MB')
            return None
        if budget == 'gif':
            if self.gif_bytes + len(content) > MAX_GIF_MEDIA:
                return None
            self.gif_bytes += len(content)
        ext = mimetypes.guess_extension((ctype or '').split(';')[0].strip()) or pathlib.PurePath(url_path.split('?')[0]).suffix or '.bin'
        ext = {'.jpe': '.jpg', '.jpeg': '.jpg'}.get(ext, ext)
        name = name or hashlib.sha256(url_path.encode()).hexdigest()[:20]
        rel = f'{kind}/{name}{ext}'
        target = self.out / 'media' / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if record:
            self.media[url_path] = rel
        self.saved[url_path] = rel
        self.media_bytes += len(content)
        return rel

    # --- the core session

    def core(self):
        s = self.s
        me = s.me
        uid = me['id']
        core = {'recorded_at': int(time.time() * 1000), 'user_id': uid}
        ping = s.get('/api/v4/system/ping?get_server_status=false') or {}
        core['server_version'] = ping.get('version') or ''
        core['config'] = s.get('/api/v4/config/client?format=old')
        core['license'] = s.get('/api/v4/license/client?format=old')
        core['me'] = s.get('/api/v4/users/me')
        core['preferences'] = s.get('/api/v4/users/me/preferences')
        core['teams'] = s.get('/api/v4/users/me/teams')
        core['team_members'] = s.get('/api/v4/users/me/teams/members')
        core['team_unreads'] = s.get('/api/v4/users/me/teams/unread?include_collapsed_threads=true')
        core['channels'] = {}
        core['channel_members'] = {}
        core['categories'] = {}
        core['team_member_lists'] = {}
        core['team_stats'] = {}
        core['public_channels'] = {}
        core['threads'] = {}
        core['drafts'] = {}
        core['scheduled_posts'] = {}
        for team in core['teams']:
            tid = team['id']
            core['channels'][tid] = s.get(f'/api/v4/users/{uid}/teams/{tid}/channels?include_deleted=true')
            core['channel_members'][tid] = s.get(f'/api/v4/users/{uid}/teams/{tid}/channels/members')
            core['categories'][tid] = s.get(f'/api/v4/users/{uid}/teams/{tid}/channels/categories')
            core['team_member_lists'][tid] = s.get(f'/api/v4/teams/{tid}/members?page=0&per_page=200')
            core['team_stats'][tid] = s.get(f'/api/v4/teams/{tid}/stats')
            core['public_channels'][tid] = (s.get(f'/api/v4/teams/{tid}/channels?page=0&per_page=200') or []) + (
                s.get(f'/api/v4/teams/{tid}/channels/deleted?page=0&per_page=200', quiet=True) or [])
            core['threads'][tid] = s.get(f'/api/v4/users/{uid}/teams/{tid}/threads?per_page=200&extended=true&deleted=false')
            core['drafts'][tid] = s.get(f'/api/v4/users/{uid}/teams/{tid}/drafts', quiet=True) or []
            core['scheduled_posts'][tid] = s.get(f'/api/v4/posts/scheduled/team/{tid}?includeDirectChannels=true', quiet=True)
            if team.get('last_team_icon_update'):
                self.save_media(f'/api/v4/teams/{tid}/image', 'teams', tid)
        core['roles'] = s.post('/api/v4/roles/names', sorted({r for x in self._role_names(core) for r in x.split()}))
        core['emoji'] = s.get('/api/v4/emoji?page=0&per_page=200&sort=name') or []
        for e in core['emoji']:
            self.save_media(f'/api/v4/emoji/{e["id"]}/image', 'emoji', e['id'])
        core['groups'] = s.get(f'/api/v4/users/{uid}/groups', quiet=True) or []
        core['custom_profile_attributes'] = s.get('/api/v4/custom_profile_attributes/fields', quiet=True) or []
        core['flagged'] = s.get(f'/api/v4/users/{uid}/posts/flagged?per_page=200', quiet=True)
        core['recent_mentions'] = s.post('/api/v4/teams/' + core['teams'][0]['id'] + '/posts/search',
                                         {'terms': f'@{me["username"]} ', 'is_or_search': True, 'time_zone_offset': 0,
                                          'page': 0, 'per_page': 30}, quiet=True)
        core['commands'] = {t['id']: s.get(f'/api/v4/teams/{t["id"]}/commands/autocomplete_suggestions?user_input=/', quiet=True)
                            for t in core['teams']}
        core['plugin_statuses'] = s.get('/api/v4/plugins/statuses', quiet=True) or []
        # Groups: Antimatter's teams and roles are custom groups (is_team, tag, color, position...).
        groups = {}
        page = 0
        while True:
            batch = s.get(f'/api/v4/groups?group_source=custom&include_member_ids=true&include_member_count=true&page={page}&per_page=200',
                          quiet=True) or []
            for g in batch:
                groups[g['id']] = g
            if len(batch) < 200:
                break
            page += 1
        core['custom_groups'] = list(groups.values())
        core['group_team_roles'] = {}
        for g in groups.values():
            role = s.get(f'/api/v4/groups/{g["id"]}/team_role', quiet=True)
            if role:
                core['group_team_roles'][g['id']] = role
        self.antimatter(core)
        return core

    def antimatter(self, core):
        """Antimatter's own endpoints (server categories, timeouts, community attributes, channel overrides, put on
        top...): replayed as recorded, per team and per channel."""
        s = self.s
        uid = core['user_id']
        for team in core['teams']:
            tid = team['id']
            for path in (f'/api/v4/teams/{tid}/server_categories', f'/api/v4/teams/{tid}/server_categories/overrides',
                         f'/api/v4/teams/{tid}/channels/managed_categories', f'/api/v4/teams/{tid}/timeouts',
                         f'/api/v4/teams/{tid}/user_attributes/fields',
                         f'/api/v4/teams/{tid}/groups_by_channels'):
                self.route(path, quiet=True)
            fields = self.routes.get(f'GET /api/v4/teams/{tid}/user_attributes/fields') or []
            members = [m['user_id'] for m in core['team_member_lists'].get(tid) or []]
            if fields and members:
                self.route(f'/api/v4/teams/{tid}/user_attributes/values/search', method='POST', body={'user_ids': members},
                           quiet=True)
            for m in members:
                self.route(f'/api/v4/teams/{tid}/members/{m}/moderation', quiet=True)
        self.route('/api/v4/properties/groups/managed_channel_categories/channel/fields?target_type=system', quiet=True,
                   key='GET /api/v4/properties/groups/managed_channel_categories/channel/fields')
        core['on_top'] = {}
        for tid, channels in core['channels'].items():
            for c in channels or []:
                cid = c['id']
                if c['type'] in ('O', 'P'):
                    self.route(f'/api/v4/channels/{cid}/overrides/effective', quiet=True)
                    self.route(f'/api/v4/channels/{cid}/overrides', quiet=True)
                    self.route(f'/api/v4/channels/{cid}/role_access', quiet=True)
                top = s.get(f'/api/v4/channels/{cid}/on_top', quiet=True)
                if top:
                    core['on_top'][cid] = top

    @staticmethod
    def _role_names(core):
        yield core['me'].get('roles', '')
        for m in core['team_members']:
            yield m.get('roles', '')
        for members in core['channel_members'].values():
            for m in members or []:
                yield m.get('roles', '')
        yield 'system_user system_admin team_user team_admin channel_user channel_admin system_guest team_guest channel_guest'

    def users(self, core):
        s = self.s
        users = []
        page = 0
        while True:
            batch = s.get(f'/api/v4/users?page={page}&per_page=200') or []
            users += batch
            if len(batch) < 200:
                break
            page += 1
        statuses = s.post('/api/v4/users/status/ids', [u['id'] for u in users]) or []
        for u in users:
            self.save_media(f'/api/v4/users/{u["id"]}/image', 'avatars', u['id'])
        return {'users': users, 'statuses': statuses,
                'bots': s.get('/api/v4/bots?per_page=200&include_deleted=true', quiet=True) or []}

    # --- posts

    def posts(self, core):
        s = self.s
        channels = {}
        for lst in list(core['channels'].values()) + list(core['public_channels'].values()):
            for c in lst or []:
                channels[c['id']] = c
        posts = {}
        for cid in channels:
            page = 0
            while True:
                pl = s.get(f'/api/v4/channels/{cid}/posts?page={page}&per_page=200', quiet=True)
                if not pl:
                    break
                posts.update(pl['posts'])
                if len(pl['order']) < 200:
                    break
                page += 1
        roots = [p for p in posts.values() if not p.get('root_id') and p.get('reply_count')]
        for p in roots:
            pl = s.get(f'/api/v4/posts/{p["id"]}/thread?perPage=1000&skipFetchThreads=false&collapsedThreads=false', quiet=True)
            if pl:
                posts.update(pl['posts'])
        # Pinned posts and channel stats per channel.
        extras = {'pinned': {}, 'stats': {}, 'members': {}}
        for cid, c in channels.items():
            st = s.get(f'/api/v4/channels/{cid}/stats?exclude_files_count=false', quiet=True)
            if st:
                extras['stats'][cid] = st
            members = s.get(f'/api/v4/channels/{cid}/members?page=0&per_page=200', quiet=True)
            if members:
                extras['members'][cid] = members
        for p in posts.values():
            for f in (p.get('metadata') or {}).get('files') or []:
                self.file(f)
        log(f'posts: {len(posts)} in {len(channels)} channels')
        return {'channels': list(channels.values()), 'posts': posts, **extras}

    def file(self, info):
        fid = info['id']
        if info.get('has_preview_image') or (info.get('mime_type') or '').startswith('image/'):
            self.save_media(f'/api/v4/files/{fid}/thumbnail', 'files', f'{fid}-thumb')
            self.save_media(f'/api/v4/files/{fid}/preview', 'files', f'{fid}-preview')
        if info.get('size', 0) <= MAX_FILE:
            self.save_media(f'/api/v4/files/{fid}', 'files', f'{fid}')
        else:
            log(f'  original of {info.get("name")} not kept ({info.get("size", 0) / 1e6:.1f} MB)')

    # --- Antimatter's own endpoints and the apps (see apps.py-like sections below)

    def apps(self, core, posts):
        import record_apps
        return record_apps.record(self, core, posts)


# --- cleaning ------------------------------------------------------------------------------------------------

class Cleaner:
    def __init__(self, server_url, users, extra_hosts=()):
        u = urllib.parse.urlsplit(server_url)
        self.site_urls = sorted({server_url.rstrip('/'), f'{u.scheme}://{u.netloc}', f'http://{u.netloc}',
                                 f'https://{u.netloc}'}, key=len, reverse=True)
        self.local_url = re.compile(
            r'https?://(localhost|127\.0\.0\.1|amdev[-\w]*|host\.docker\.internal|antimatter-gifs|[\w-]+\.local)(:\d+)?', re.I)
        self.email_of = {}
        for user in users:
            if user.get('email'):
                self.email_of[user['email'].lower()] = f'{user["username"]}@{DEMO_DOMAIN}'

    def string(self, s):
        # The seed's own domains, kept on reserved names (example.com style) in the demo.
        s = s.replace('lumenlabs.dev', DEMO_DOMAIN)
        for url in self.site_urls:
            s = s.replace(url, SITE)
        s = self.local_url.sub(SITE, s)

        def email(m):
            whole = m.group(0).lower()
            if whole in self.email_of:
                return self.email_of[whole]
            if m.group(2).lower() in test_fixtures.EMAIL_DOMAINS:
                return m.group(0)
            return f'{m.group(1)}@{DEMO_DOMAIN}'
        s = EMAIL.sub(email, s)
        s = PRIVATE_IP.sub('203.0.113.10', s)
        return s

    def value(self, v, key=''):
        if isinstance(key, str) and key and SECRET_KEYS.match(key) and not KEEP_KEYS.match(key):
            return '' if isinstance(v, str) else ([] if isinstance(v, list) else ({} if isinstance(v, dict) else v if isinstance(v, (bool, int, float)) or v is None else ''))
        if isinstance(v, str):
            return self.string(v)
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, dict):
            return {self.string(k) if isinstance(k, str) else k: self.value(x, k) for k, x in v.items()}
        return v


def demo_config(config):
    """The client config, set for a demo that is always signed in."""
    config = dict(config)
    config.update({
        'SiteURL': SITE,
        'WebsocketURL': '',
        'GiphySdkKey': '',
        'EnableGifPicker': config.get('EnableGifPicker', 'true'),
        'GoogleDeveloperKey': '',
        'CWSURL': '',
        'AsymmetricSigningPublicKey': '',
        'EnableDiagnostics': 'false',
        'DiagnosticsEnabled': 'false',
        'TelemetryId': '',
        'DiagnosticId': '',
        'SendEmailNotifications': 'false',
        'EnableEmailInvitations': 'false',
        'EnableUserAccessTokens': 'false',
        'ExperimentalEnableAutomaticReplies': config.get('ExperimentalEnableAutomaticReplies', 'false'),
    })
    return config


def check_token(out, token):
    found = [f for f in out.rglob('*') if f.is_file() and token.encode() in f.read_bytes()]
    if found:
        raise SystemExit(f'the session token is in {", ".join(str(f) for f in found)}: nothing written')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--server', default='http://localhost:8067')
    p.add_argument('--user', default='maya')
    p.add_argument('--password-file', type=pathlib.Path)
    p.add_argument('--out', type=pathlib.Path, default=OUT)
    args = p.parse_args()

    password = (args.password_file.read_text().strip() if args.password_file else
                os.environ.get('DEMO_PASSWORD') or getpass.getpass(f'password of {args.user}: '))
    server = Server(args.server, args.user, password)
    staging = args.out.with_name(args.out.name + '.new')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    rec = Recorder(server, staging)
    log('recording the session...')
    core = rec.core()
    users = rec.users(core)
    posts = rec.posts(core)
    log('recording the apps...')
    apps = rec.apps(core, posts)

    cleaner = Cleaner(server.url, users['users'])
    core['config'] = demo_config(core['config'] or {})
    docs = {
        'core.json': core,
        'users.json': users,
        'posts.json': posts,
        'routes.json': rec.routes,
        'apps.json': apps,
        'media.json': rec.media,
    }
    for name, doc in docs.items():
        clean = cleaner.value(doc)
        (staging / name).write_text(json.dumps(clean, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n')

    check_token(staging, server.token)
    problems = []
    for f in staging.glob('*.json'):
        problems += test_fixtures.problems_in(json.loads(f.read_text()), f.name)
    if problems:
        for x in problems[:40]:
            log('  ' + x)
        raise SystemExit(f'{len(problems)} problems in the recording (kept in {staging} to look at): nothing replaced')
    if args.out.exists():
        shutil.rmtree(args.out)
    staging.rename(args.out)
    for e in server.errors:
        log('  not recorded: ' + e)
    log(f'fixtures written to {args.out}: {sum(f.stat().st_size for f in args.out.rglob("*") if f.is_file()) / 1e6:.1f} MB '
        f'({len(rec.routes)} routes, {len(rec.media)} media files)')


if __name__ == '__main__':
    main()
