#!/usr/bin/env python3
"""Builds the antimatter.chat pages: each page's content (src/pages/*.html) inside the shared layout, in English
at the site's root and in each translation under /<lang>/.

    python3 src/build.py            build every page in every language
    python3 src/build.py --strings  write src/i18n/en.json, the catalog of the layout's and comparisons' strings
    python3 src/build.py --stamp    record in each translated page the version of the English page it translates

Translations: src/pages/<lang>/<page>.html is the page in that language (a page without one is built from the
English page), and src/i18n/<lang>.json translates the shared strings (navigation, footer, comparison tables),
keyed by their English text. A translated page whose English page changed since it was stamped is reported as
stale.

The generated pages are committed: GitHub Pages serves the repository as it is, with no build step.
A page's content file starts with front matter lines ("key: value") up to a line with "---":
    title       the <title> and the share preview title
    description the meta description and share preview text
    plain       "yes" for pages without a dark hero (the navigation bar is solid from the top)
"""
import hashlib
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ROOT / 'src' / 'pages'
SITE = 'https://antimatter.chat'
GITHUB = 'https://github.com/AntimatterChat'
I18N = ROOT / 'src' / 'i18n'

# The site's languages: URL directory, then the <html lang> code and the name in the language itself.
LANGS = {
    'en': ('en', 'English'),
    'de': ('de', 'Deutsch'),
    'es': ('es', 'Español'),
    'fr': ('fr', 'Français'),
    'it': ('it', 'Italiano'),
    'nl': ('nl', 'Nederlands'),
    'pl': ('pl', 'Polski'),
    'pt-br': ('pt-BR', 'Português (Brasil)'),
    'ja': ('ja', '日本語'),
    'ko': ('ko', '한국어'),
    'zh-cn': ('zh-CN', '简体中文'),
    'zh-tw': ('zh-TW', '繁體中文'),
    'bg': ('bg', 'Български'),
    'ca': ('ca', 'Català'),
    'cs': ('cs', 'Čeština'),
    'da': ('da', 'Dansk'),
    'el': ('el', 'Ελληνικά'),
    'fi': ('fi', 'Suomi'),
    'fil': ('fil', 'Filipino'),
    'hu': ('hu', 'Magyar'),
    'id': ('id', 'Bahasa Indonesia'),
    'ms': ('ms', 'Bahasa Melayu'),
    'nb': ('nb', 'Norsk bokmål'),
    'pt': ('pt-PT', 'Português (Portugal)'),
    'ro': ('ro', 'Română'),
    'ru': ('ru', 'Русский'),
    'sv': ('sv', 'Svenska'),
    'tr': ('tr', 'Türkçe'),
    'uk': ('uk', 'Українська'),
    'vi': ('vi', 'Tiếng Việt'),
    'hi': ('hi', 'हिन्दी'),
    'bn': ('bn', 'বাংলা'),
    'ta': ('ta', 'தமிழ்'),
    'th': ('th', 'ไทย'),
    'ar': ('ar', 'العربية'),
    'fa': ('fa', 'فارسی'),
    'he': ('he', 'עברית'),
    'ur': ('ur', 'اردو'),
}
# The languages written right to left.
RTL = {'ar', 'fa', 'he', 'ur'}
CATALOGS = {}


def t(lang, text):
    """The translation of a shared string, or the English text when it has none."""
    if lang not in CATALOGS:
        f = I18N / f'{lang}.json'
        CATALOGS[lang] = json.loads(f.read_text()) if lang != 'en' and f.exists() else {}
    return CATALOGS[lang].get(text) or text


def lang_dir(lang):
    return '' if lang == 'en' else lang + '/'

# Icons, drawn with strokes like the app's own.
ICONS = {
    'server': '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    'shield': '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    'lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    'code': '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
    'chat': '<path d="M4 5h16v11H9l-5 4z"/>',
    'thread': '<path d="M6 3v10a4 4 0 0 0 4 4h9"/><path d="m15 13 4 4-4 4"/>',
    'sparkle': '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 15c.3 1.6 1 2.3 2.5 2.5-1.5.2-2.2.9-2.5 2.5-.3-1.6-1-2.3-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z"/>',
    'mic': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    'speaker': '<path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
    'video': '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
    'screen': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    'plug': '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
    'apps': '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    'pad': '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    'draw': '<path d="M4 20c4 0 4-6 8-6s4 4 8 4"/><path d="m14 4 6 6-7 7H7v-6z"/>',
    'kanban': '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
    'runbook': '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="m9 10 2 2 4-4M9 16h6"/>',
    'calendar': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    'mail': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    'check': '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
    'poll': '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    'clock': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    'moon': '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    'link': '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    'ack': '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    'flame': '<path d="M12 21c-3.9 0-7-2.7-7-6.5 0-3.4 2.6-5.6 4-8.5.8 1.8 1.9 2.8 3 3.3.2-2.6 1.4-4.8 3-6.3.2 3.3 4 5.6 4 10.9 0 4-3.1 7.1-7 7.1z"/>',
    'globe': '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
    'image': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    'inbox': '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13l2.5 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    'eye-off': '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6a17 17 0 0 1-2.6 3.2M6.6 7.6C4.4 9 3 11.1 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    'pin': '<path d="M9 3h6l-1 7 3 3H7l3-3z"/><path d="M12 13v8"/>',
    'bell': '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    'users': '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6 6 0 0 1 3.5 5.8"/>',
    'search': '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    'mobile': '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
    'heart': '<path d="M12 20s-7.5-4.6-7.5-10A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
    'translate': '<path d="M4 5h9M8.5 3v2M6 5c.5 3 2.5 5.5 5.5 7M11 5c-.8 3.5-3.2 6.5-6.5 8"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
    'transcript': '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12v3M11.5 10.5v6M14 12.5v2"/>',
    'captions': '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6"/>',
    'hand': '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 12.5V9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.6-2.2L4 15.6a1.5 1.5 0 0 1 2.3-1.9L8 15.5V13"/>',
    'book': '<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
    'scale': '<path d="M12 3v18M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z"/>',
    'database': '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
    'spoiler': '<rect x="3" y="7" width="18" height="10" rx="3"/><path d="M7 12h.01M10.5 12h.01M14 12h.01M17.5 12h.01"/>',
    'reply': '<path d="M10 7 4 12l6 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
    'sticker': '<path d="M5 4h14v9l-7 7H5z"/><path d="M12 20v-5a2 2 0 0 1 2-2h5"/>',
    'github': '<path d="M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
}


def icon(name, cls=''):
    return f'<span class="icon {cls}"><svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg></span>'


NAV = [
    ('Features', 'features.html'),
    ('Compare', 'compare/index.html'),
    ('Self-host', 'install.html'),
    ('About', 'about.html'),
]

FOOTER = [
    ('Product', [('Features', 'features.html'), ('Get started', 'install.html'), ('Compare', 'compare/index.html'),
                 ('Source code', GITHUB)]),
    ('Compare', [('Slack', 'compare/slack.html'), ('Mattermost', 'compare/mattermost.html'),
                 ('Rocket.Chat', 'compare/rocketchat.html'), ('Discord', 'compare/discord.html'),
                 ('Microsoft Teams', 'compare/teams.html'), ('Element (Matrix)', 'compare/element.html')]),
    ('Project', [('About', 'about.html'), ('Help & support', 'help.html'), ('Report a problem', 'help.html#report'),
                 ('Security', 'help.html#security')]),
    ('Legal', [('Privacy policy', 'privacy.html'), ('Terms of use', 'terms.html'), ('License', 'about.html#license')]),
]


FOOTER_TEXT = 'Self-hosted, open-source team chat: channels, threads, calls and voice rooms, apps and AI, on your own server.'
LEGAL_LICENSE = 'Antimatter is free software, licensed under the GNU AGPL v3.0. Website content © Antimatter contributors.'
LEGAL_TRADEMARKS = 'Antimatter is an independent project. Product names are trademarks of their respective owners.'


def link(href, base):
    return href if href.startswith('http') else base + href


def lang_menu(path, lang, root):
    """The language selector: the same page in every language. A <details> menu, so it works without scripts."""
    items = ''.join(
        f'<li><a href="{root}{lang_dir(code)}{path}" hreflang="{tag}" lang="{tag}"'
        f'{" aria-current=\"true\"" if code == lang else ""}>{name}</a></li>' for code, (tag, name) in LANGS.items())
    globe = ('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/>'
             '<path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>')
    return (f'<details class="lang"><summary aria-label="{html.escape(t(lang, "Language"), quote=True)}">{globe}'
            f'<span>{LANGS[lang][0].split("-")[0].upper()}</span></summary><ul>{items}</ul></details>')


def layout(path, meta, body, lang):
    """The page around a page's content. path is the page's path within a language, e.g. compare/slack.html."""
    root = '../' * (path.count('/') + (lang != 'en'))
    base = root + lang_dir(lang)
    tag = LANGS[lang][0]
    page_url = SITE + '/' + lang_dir(lang) + ('' if path == 'index.html' else path)
    alternates = ''.join(
        f'<link rel="alternate" hreflang="{tg}" href="{SITE}/{lang_dir(code)}{"" if path == "index.html" else path}">\n'
        for code, (tg, _) in LANGS.items())
    alternates += f'<link rel="alternate" hreflang="x-default" href="{SITE}/{"" if path == "index.html" else path}">\n'
    nav = ''.join(
        f'<a href="{base}{href}"{" aria-current=\"page\"" if href == path else ""}>{t(lang, label)}</a>' for label, href in NAV)
    cols = ''.join(
        f'<div><h4>{t(lang, title)}</h4><ul>' + ''.join(f'<li><a href="{link(h, base)}">{t(lang, l)}</a></li>' for l, h in items)
        + '</ul></div>' for title, items in FOOTER)
    title = meta.get('title', 'Antimatter')
    full_title = title if title.startswith('Antimatter') else f'{title} · Antimatter'
    description = html.escape(meta.get('description', ''), quote=True)
    body_class = ' class="plain"' if meta.get('plain') == 'yes' else ''
    return f'''<!doctype html>
<html lang="{tag}"{" dir=\"rtl\"" if lang in RTL else ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(full_title)}</title>
<meta name="description" content="{description}">
<meta property="og:title" content="{html.escape(full_title, quote=True)}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="website">
<meta property="og:url" content="{page_url}">
<meta property="og:locale" content="{tag.replace("-", "_")}">
<meta property="og:image" content="{SITE}/assets/img/shots/hero.webp">
<meta name="theme-color" content="#1e1f22">
<link rel="canonical" href="{page_url}">
{alternates}<link rel="icon" href="{root}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{root}assets/css/site.css">
<script src="{root}assets/js/site.js" defer></script>
</head>
<body{body_class}>
<a class="skip" href="#main">{t(lang, "Skip to content")}</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="{base}index.html"><img src="{root}assets/img/logo.svg" alt="" width="34" height="34">Antimatter</a>
    <button class="nav-toggle" type="button" aria-label="{html.escape(t(lang, "Menu"), quote=True)}" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <nav class="nav-links" aria-label="{html.escape(t(lang, "Main"), quote=True)}">{nav}<a class="btn btn-primary btn-small" href="{GITHUB}/antimatter">GitHub</a>{lang_menu(path, lang, root)}</nav>
  </div>
</header>
<main id="main">
{body}
</main>
<footer>
  <div class="wrap">
    <div class="cols">
      <div>
        <a class="brand" href="{base}index.html"><img src="{root}assets/img/logo.svg" alt="" width="34" height="34">Antimatter</a>
        <p>{t(lang, FOOTER_TEXT)}</p>
      </div>
      {cols}
    </div>
    <div class="legal">
      <span>{t(lang, LEGAL_LICENSE)}</span>
      <span>{t(lang, LEGAL_TRADEMARKS)}</span>
    </div>
  </div>
</footer>
</body>
</html>
'''


def render(text, root, base):
    """Expands the content's shortcuts: {{icon:name}}, {{icon:name:cls}} and {{root}}, the path to the site's root
    for assets (assets/...) and to the root of the page's language for links to pages."""
    text = re.sub(r'\{\{icon:([a-z-]+)(?::([a-z]+))?\}\}', lambda m: icon(m.group(1), m.group(2) or ''), text)
    return text.replace('{{root}}assets/', root + 'assets/').replace('{{root}}', base)


def cell(value, lang):
    state, note = value
    mark = {'yes': f'<span class="yes">✓ {t(lang, "Yes")}</span>', 'part': f'<span class="part">◐ {t(lang, "Partly")}</span>',
            'no': f'<span class="no">✕ {t(lang, "No")}</span>'}[state]
    return mark + (f'<small>{html.escape(t(lang, note))}</small>' if note else '')


def compare_table(apps, lang):
    """A comparison table of Antimatter and the given apps (keys of compare_data.APPS)."""
    import compare_data as cd
    head = f'<th>{t(lang, "Feature")}</th><th class="us">Antimatter</th>' + ''.join(f'<th>{cd.APPS[a]}</th>' for a in apps)
    rows, group = [], None
    for g, feature, values in cd.ROWS:
        if g != group:
            group = g
            rows.append(f'<tr class="group"><td colspan="{len(apps) + 2}"><span>{t(lang, g)}</span></td></tr>')
        rows.append(f'<tr><td>{t(lang, feature)}</td><td class="us">{cell(values["antimatter"], lang)}</td>'
                    + ''.join(f'<td>{cell(values[a], lang)}</td>' for a in apps) + '</tr>')
    return (f'<div class="table-wrap"><table class="compare"><thead><tr>{head}</tr></thead><tbody>'
            + ''.join(rows) + '</tbody></table></div>')


LEGEND = ('"Partly" means the feature needs a paid plan, an add-on or a plugin, or exists in a limited form; the note '
          'says which. Based on each product\'s public documentation as of October 2026: plans and features change, so '
          'check the vendor\'s own site before deciding. Spotted a mistake? <a href="{issues}">Tell us</a>.')

# The comparison pages' own strings; {name} is the other app.
COMPARE = {
    'index_title': 'Compare Antimatter with other chat apps',
    'index_description': 'Antimatter compared with Slack, Mattermost, Rocket.Chat, Discord, Microsoft Teams and Element: hosting, licensing, messaging, calls, apps, AI and security, feature by feature.',
    'eyebrow': 'Compare',
    'index_h1': 'Antimatter and other chat apps',
    'index_lead': 'How Antimatter compares with the chat apps teams use most, feature by feature. Every Antimatter feature is free software and included, with nothing held back for a paid edition.',
    'one_h2': 'One app at a time',
    'one_p': 'Each comparison also says when the other app may suit you better.',
    'vs': 'Antimatter vs {name}',
    'app_description': 'How Antimatter, the self-hosted open-source team chat, compares with {name}: hosting, licensing, messaging, calls, apps, AI and security.',
    'ours': 'Why teams choose Antimatter',
    'better': 'When {name} may suit you better',
    'feature_by_feature': 'Feature by feature',
    'see_all': 'See every app side by side',
}


def compare_pages(lang):
    """The comparison pages' content in a language: the overview and one page per app, as {path: content}."""
    import compare_data as cd
    c = {k: t(lang, v) for k, v in COMPARE.items()}
    legend = '<p class="legend">' + t(lang, LEGEND).replace('{issues}', 'https://github.com/AntimatterChat/antimatter.chat/issues') + '</p>'
    cards = ''.join(
        f'<a class="card reveal" href="{key}.html" style="display:block"><h3>{c["vs"].replace("{name}", name)}</h3>'
        f'<p>{html.escape(t(lang, cd.NOTES[key]["lead"]))}</p></a>' for key, name in cd.APPS.items())
    pages = {'compare/index.html': f'''title: {c["index_title"]}
description: {c["index_description"]}
plain: yes
---
<div class="page-head"><div class="wrap"><span class="eyebrow">{c["eyebrow"]}</span><h1>{c["index_h1"]}</h1>
<p>{c["index_lead"]}</p></div></div>
<section><div class="wrap">{compare_table(list(cd.APPS), lang)}{legend}</div></section>
<section class="alt"><div class="wrap"><div class="section-title reveal"><h2>{c["one_h2"]}</h2><p>{c["one_p"]}</p></div>
<div class="grid grid-3">{cards}</div></div></section>
'''}
    for key, name in cd.APPS.items():
        n = cd.NOTES[key]
        better = ''.join(f'<li>{html.escape(t(lang, x))}</li>' for x in n['better'])
        ours = ''.join(f'<li>{html.escape(t(lang, x))}</li>' for x in n['ours'])
        vs = c['vs'].replace('{name}', name)
        pages[f'compare/{key}.html'] = f'''title: {vs}
description: {c["app_description"].replace("{name}", name)}
plain: yes
---
<div class="page-head"><div class="wrap"><span class="eyebrow">{c["eyebrow"]}</span><h1>{vs}</h1><p>{html.escape(t(lang, n["lead"]))}</p></div></div>
<section><div class="wrap"><div class="grid grid-2">
<div class="card"><h3>{c["ours"]}</h3><ul>{ours}</ul></div>
<div class="card"><h3>{c["better"].replace("{name}", name)}</h3><ul>{better}</ul></div>
</div></div></section>
<section class="alt"><div class="wrap"><div class="section-title"><h2>{c["feature_by_feature"]}</h2></div>{compare_table([key], lang)}{legend}
<p style="margin-top:24px"><a href="index.html">{c["see_all"]}</a></p></div></section>
'''
    return pages


def shared_strings():
    """Every shared string to translate: the layout's, the comparison pages' and the comparison data's."""
    import compare_data as cd
    out = [label for label, _ in NAV]
    for title, items in FOOTER:
        out += [title] + [label for label, _ in items]
    out += [FOOTER_TEXT, LEGAL_LICENSE, LEGAL_TRADEMARKS, 'Skip to content', 'Menu', 'Main', 'Language',
            'Yes', 'Partly', 'No', 'Feature', LEGEND] + list(COMPARE.values())
    for g, feature, values in cd.ROWS:
        out += [g, feature] + [note for _, note in values.values() if note]
    for n in cd.NOTES.values():
        out += [n['lead']] + n['better'] + n['ours']
    seen = []
    for x in out:
        if x not in seen and x not in cd.APPS.values() and x not in ('GitHub', 'Slack', 'Mattermost', 'Rocket.Chat', 'Discord', 'Microsoft Teams', 'Element (Matrix)'):
            seen.append(x)
    return seen


def source_hash(name):
    """The version of an English page, recorded in its translations as "source: <hash>"."""
    return hashlib.sha256((PAGES / name).read_bytes()).hexdigest()[:12]


def parse(raw):
    head, _, content = raw.partition('\n---\n')
    return dict(line.split(': ', 1) for line in head.splitlines() if ': ' in line), content


def stamp():
    """Records the current version of each English page in its translations."""
    for code in LANGS:
        for f in sorted((PAGES / code).glob('*.html')) if code != 'en' else []:
            raw = f.read_text()
            head, _, content = raw.partition('\n---\n')
            lines = [l for l in head.splitlines() if not l.startswith('source: ')] + [f'source: {source_hash(f.name)}']
            f.write_text('\n'.join(lines) + '\n---\n' + content)
            print('stamped', f.relative_to(PAGES))


def main():
    if '--strings' in sys.argv:
        I18N.mkdir(exist_ok=True)
        (I18N / 'en.json').write_text(json.dumps({x: x for x in shared_strings()}, ensure_ascii=False, indent=2) + '\n')
        print('wrote', I18N / 'en.json')
        return
    if '--stamp' in sys.argv:
        stamp()
        return
    english = sorted(f.name for f in PAGES.glob('*.html'))
    for code in LANGS:
        pages = {}
        for name in english:
            if code != 'en' and name == '404.html':
                continue  # GitHub Pages serves only the root's 404 page.
            translated = PAGES / code / name
            if code != 'en' and translated.exists():
                meta, content = parse(translated.read_text())
                if meta.get('source') != source_hash(name):
                    print(f'stale: {code}/{name} translates an older version of {name}')
            else:
                if code != 'en':
                    print(f'untranslated: {code}/{name}')
                meta, content = parse((PAGES / name).read_text())
            pages[name] = (meta, content)
        for rel, raw in compare_pages(code).items():
            pages[rel] = parse(raw)
        for rel, (meta, content) in pages.items():
            root = '../' * (rel.count('/') + (code != 'en'))
            out = ROOT / lang_dir(code) / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(layout(rel, meta, render(content.strip(), root, root + lang_dir(code)), code))
    print('built', len(LANGS), 'languages')


if __name__ == '__main__':
    main()
