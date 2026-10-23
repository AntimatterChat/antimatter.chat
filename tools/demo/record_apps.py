"""The apps' part of record_fixtures.py: the data of the default apps, from their own routes, as maya sees it.

Each app's data goes in apps.json under its plugin id, in the shape the mock (src/demo/mock/plugins.js) serves and
changes; answers that only need replaying go in routes.json, and images in media/.
"""
import base64
import json
import re
import urllib.parse

NOTES = 'com.antimatterchat.notes'
WHITEBOARD = 'com.antimatterchat.whiteboard'
POLLS = 'com.antimatterchat.polls'
TODO = 'com.mattermost.plugin-todo'
MEMES = 'memes'
GIFS = 'com.antimatterchat.gifs'
VOICE = 'com.antimatterchat.voice-channels'
CALLS = 'com.mattermost.calls'


def log(*a):
    import sys
    print(*a, file=sys.stderr, flush=True)


def record(rec, core, posts):
    s = rec.s
    out = {}
    channel_ids = [c['id'] for c in posts['channels']]
    all_posts = posts['posts'].values()
    out[NOTES] = relay_docs(rec, NOTES, channel_ids)
    out[WHITEBOARD] = relay_docs(rec, WHITEBOARD, channel_ids, whiteboard=True)
    out[POLLS] = polls(rec, all_posts)
    out[TODO] = todo(rec, channel_ids)
    out[MEMES] = memes(rec, all_posts)
    out[GIFS] = gifs(rec, all_posts)
    out[VOICE] = voice(rec)
    out[CALLS] = calls(rec, core, posts)
    hook_icons(rec, all_posts, core)
    return out


# --- Notes and Whiteboard: documents synced through the "relay" routes ------------------------------------------

def relay_docs(rec, pid, channel_ids, whiteboard=False):
    s = rec.s
    base = f'/plugins/{pid}/api/v1'
    docs = {}
    by_channel = {}
    for cid in channel_ids:
        lst = s.get(f'{base}/docs?channel_id={cid}', quiet=True) or []
        if lst:
            by_channel[cid] = [d['id'] for d in lst]
        for d in lst:
            docs[d['id']] = d
    personal = s.get(f'{base}/docs', quiet=True) or []
    for d in personal:
        docs[d['id']] = d
    favorites = [d['id'] for d in s.get(f'{base}/favorites', quiet=True) or []]
    states = {}
    for did in docs:
        states[did] = s.get(f'{base}/docs/{did}/state', quiet=True)
        if whiteboard:
            rec.save_media(f'{base}/docs/{did}/thumbnail', 'whiteboard', did)
    out = {'docs': docs, 'channels': by_channel, 'personal': [d['id'] for d in personal], 'favorites': favorites,
           'states': states}
    if whiteboard:
        libs = {}
        for cid in channel_ids[:1]:
            libs = s.get(f'{base}/libraries?channel_id={cid}', quiet=True) or {}
        out['libraries'] = libs
        # Image elements' files.
        files = {}
        for did, st in states.items():
            for blob in [st.get('snapshot')] + [u.get('data') for u in (st.get('updates') or [])] if st else []:
                if not blob:
                    continue
                try:
                    scene = json.loads(base64.b64decode(blob))
                except ValueError:
                    continue
                for el in scene.get('elements', []):
                    if el.get('type') == 'image' and el.get('fileId'):
                        f = s.get(f'{base}/docs/{did}/files/{el["fileId"]}', quiet=True)
                        if f:
                            files[f'{did}/{el["fileId"]}'] = f
        out['files'] = files
    log(f'{pid}: {len(docs)} documents')
    return out


# --- Polls -------------------------------------------------------------------------------------------------------

def polls(rec, all_posts):
    s = rec.s
    found = {}
    for p in all_posts:
        if p.get('type') == 'custom_poll' and (p.get('props') or {}).get('poll_id'):
            poll = s.get(f'/plugins/{POLLS}/api/v1/polls/{p["props"]["poll_id"]}', quiet=True)
            if poll:
                found[poll['id']] = poll
    log(f'polls: {len(found)}')
    return {'polls': found}


# --- Todo ----------------------------------------------------------------------------------------------------------

def todo(rec, channel_ids):
    s = rec.s
    base = f'/plugins/{TODO}'
    lists = s.get(f'{base}/lists', quiet=True) or {'my': [], 'in': [], 'out': []}
    channels = {}
    for cid in channel_ids:
        c = s.get(f'{base}/api/v1/channels/{cid}/todos', quiet=True)
        if c and c.get('todos'):
            channels[cid] = c
    # Todo 0.9's lists: maya's own, her favourites and the channels', each with its todos (GET /api/v1/lists/{id}).
    details, order = {}, []

    def keep(infos):
        for info in infos or []:
            if info['id'] not in details:
                detail = s.get(f'{base}/api/v1/lists/{info["id"]}', quiet=True)
                if detail:
                    details[info['id']] = detail
                    order.append(info['id'])

    keep(s.get(f'{base}/api/v1/lists?scope=mine', quiet=True))
    favorites = s.get(f'{base}/api/v1/lists?scope=favorites', quiet=True) or []
    keep(favorites)
    for cid in channel_ids:
        keep(s.get(f'{base}/api/v1/lists?scope=channel&channel_id={cid}', quiet=True))
    out = {'lists': lists, 'assigned': s.get(f'{base}/api/v1/assigned', quiet=True) or [],
           'following': s.get(f'{base}/api/v1/following', quiet=True) or [], 'channels': channels,
           'todo_lists': [details[i] for i in order], 'favorites': [f['id'] for f in favorites]}
    log(f'todo: {sum(len(v or []) for v in lists.values())} sent and received, {len(details)} lists '
        f'({sum(len(d.get("items") or []) for d in details.values())} todos), {len(favorites)} favourites')
    return out


# --- Memes -------------------------------------------------------------------------------------------------------

def memes(rec, all_posts):
    s = rec.s
    base = f'/plugins/{MEMES}/api/v1'
    templates = s.get(f'{base}/templates', quiet=True) or []
    for t in templates:
        for width in (240, 480):
            rec.save_media(f'{base}/templates/{t["name"]}/thumbnail?width={width}', 'memes', f'{t["name"]}-{width}')
    rec.save_media(f'/plugins/{MEMES}/fonts/anton.ttf', 'memes', 'anton')
    log(f'memes: {len(templates)} templates')
    return {'templates': templates, 'recent': s.get(f'{base}/recent', quiet=True) or [],
            'config': s.get(f'{base}/config', quiet=True) or {'can_add': False, 'max_file_size': 0}}


# --- GIFs ----------------------------------------------------------------------------------------------------------

def gifs(rec, all_posts):
    s = rec.s
    base = f'/plugins/{GIFS}/api/v1'
    out = {'config': s.get(f'{base}/config', quiet=True) or {'configured': False}, 'categories': {}, 'pages': {}}
    for kind in ('gif', 'sticker'):
        out['categories'][kind] = s.get(f'{base}/categories?kind={kind}&locale=en', quiet=True) or []
        out['pages'][f'{kind}:'] = s.get(f'{base}/featured?kind={kind}&locale=en&limit=24', quiet=True) or {'items': []}
        for c in out['categories'][kind]:
            q = c.get('searchterm') or c.get('name')
            out['pages'][f'{kind}:{q}'] = s.get(
                f'{base}/search?kind={kind}&q={urllib.parse.quote(q)}&locale=en&limit=24', quiet=True) or {'items': []}
    # Their media, within a budget: first what the posts show, then the pickers' categories and pages (an item whose
    # preview doesn't fit is dropped).
    for p in all_posts:
        item = (p.get('props') or {}).get('antimatter_gif')
        if item:
            media_of(rec, item, full=True)
    for key, page in out['pages'].items():
        kept = []
        for item in page.get('items', []):
            if media_of(rec, item):
                kept.append(item)
        page['items'] = kept
        page.pop('next', None)
    for c in sum(out['categories'].values(), []):
        if c.get('image'):
            rec.save_media(c['image'], 'gifs', budget='gif')
    out['favorites'] = s.get(f'{base}/favorites', quiet=True) or []
    out['recent'] = s.get(f'{base}/recent', quiet=True) or []
    log(f'gifs: {sum(len(p["items"]) for p in out["pages"].values())} items, {rec.gif_bytes / 1e6:.1f} MB of media')
    return out


def media_of(rec, item, full=False):
    """Saves an item's preview (and the media posted with it); False when it didn't fit."""
    preview = (item.get('preview') or {}).get('url')
    if not preview or not rec.save_media(preview, 'gifs', budget='gif'):
        return False
    for key in ('post', 'still') + (('image',) if full else ()):
        url = (item.get(key) or {}).get('url')
        if url:
            rec.save_media(url, 'gifs', budget='gif')
    return True


# --- Voice channels ----------------------------------------------------------------------------------------------

def voice(rec):
    s = rec.s
    base = f'/plugins/{VOICE}/api/v1'
    config = s.get(f'{base}/config', quiet=True) or {}
    # Opening a voice channel would join a call: the demo has no media server.
    config['auto_join'] = False
    return {'config': config, 'channels': s.get(f'{base}/channels', quiet=True) or []}


# --- Calls -----------------------------------------------------------------------------------------------------------

def calls(rec, core, posts):
    """Only the channels' call settings and the version: the mock serves its own client config (no media server,
    no ringing, no TURN), and the recorded config holds the admin's secrets."""
    s = rec.s
    base = f'/plugins/{CALLS}'
    channels = s.get(f'{base}/channels', quiet=True) or []
    for c in channels:
        c.pop('call', None)
    return {'channels': channels, 'version': (s.get(f'{base}/version', quiet=True) or {}).get('version', '')}


# --- Integration icons: webhooks and bots with icons on the hooks container -----------------------------------------

ICON_KEYS = ('override_icon_url', 'author_icon', 'footer_icon', 'thumb_url', 'image_url')


def hook_icons(rec, all_posts, core):
    """Copies the images that integrations' posts point to on the local hooks container, and points them to the copy."""
    local = re.compile(r'^https?://(localhost|127\.0\.0\.1|amdev-hooks)(:\d+)?/')

    def fix(url):
        if not isinstance(url, str) or not local.match(url):
            return url
        fetch = local.sub(lambda m: f'http://localhost{m.group(2) or ""}/', url)
        rel = rec.save_media(fetch, 'hooks', record=False)
        return f'__MEDIA__{rel}' if rel else ''

    for p in all_posts:
        props = p.get('props') or {}
        for k in ICON_KEYS:
            if k in props:
                props[k] = fix(props[k])
        for a in props.get('attachments') or []:
            for k in ICON_KEYS:
                if k in a:
                    a[k] = fix(a[k])
