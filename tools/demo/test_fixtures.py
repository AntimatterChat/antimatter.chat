#!/usr/bin/env python3
"""Checks that the demo's fixtures (src/demo/fixtures/) hold nothing private: no token, password, secret key, real
e-mail address, private or local network address, address of the server they were recorded from, or link to a
real-looking domain (only reserved *.example names and Antimatter's own places are allowed).

    python3 tools/demo/test_fixtures.py        (or python3 -m unittest tools/demo/test_fixtures.py)

record_fixtures.py cleans what it records (see Cleaner there); this test is the safety net, run by the Pages
workflow before every deployment.
"""
import json
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'src' / 'demo' / 'fixtures'
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# The only e-mail domains fixtures may hold.
EMAIL_DOMAINS = {'lumenlabs.example', 'example.com', 'example.org', 'example.net', 'example'}
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)')
# Keys whose value must be empty when present.
SECRET_KEY = re.compile(
    r'(^|_)(token|password|passwd|secret|salt|api_?key|access_?key|private_?key|session_?id|auth_?data|mfa_?secret|'
    r'credential|credentials|cookie)s?$|^(giphysdkkey|googledeveloperkey|asymmetricsigningpublickey|tenorapikey|'
    r'gifapikey|apikey|clientsecret|turnserverscredentials|turnstaticauthsecret|icehostoverride|rtcdserviceurl|'
    r'serviceurl|pushnotificationserver)$', re.I)
# Keys allowed to look like secrets: they name things, or are flags and counts.
SECRET_KEY_OK = re.compile(
    r'^(token_type|csrf_token_required|is_token|has_password|password_.*|.*_enabled|enable.*|.*length|'
    r'requirepassword|passwordenableforgotlink|passwordminimumlength|passwordrequire\w*|enableuseraccesstokens|'
    r'maximumpersonalaccesstokenlifetimedays|.*tokenlifetime.*)$', re.I)
PRIVATE_IP = re.compile(
    r'(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|'
    r'127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)(?![\d.])')
LOCAL_HOST = re.compile(r'\blocalhost\b|\[::1\]|\bamdev[-\w]*\b|host\.docker\.internal|\.local\b', re.I)
# A Mattermost session or access token is 26 lowercase letters and digits, like an id: they can't be told apart,
# so the recorder checks its own token; here, bearer headers and JWTs are refused.
BEARER = re.compile(r'Bearer\s+[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}')
PASSWORDS = ['Antimatter-Local-1']
# Links may only lead to reserved names (RFC 2606: *.example, example.com/org/net) or to Antimatter's own places;
# a real-looking domain in the sample data could be someone's.
DOMAIN = re.compile(
    r'(?<![@\w.-])(https?://)?((?:[a-z0-9-]+\.)+(?:[a-z]{2,24}))(?::\d+)?(/[^\s"\'<>)\]]*)?', re.I)
# Without a scheme, only the common top-level domains are taken for domains: dotted names such as permission or
# message ids (authentication.roles.team), files (notes.md) and code (window.location) are not.
BARE_TLDS = re.compile(r'\.(com|org|net|dev|io|app|co|ai)$', re.I)
ALLOWED_HOSTS = {'antimatter.chat', 'www.antimatter.chat', 'www.w3.org'}
# github.com only for Antimatter's own repositories.
ALLOWED_PATHS = {'github.com': re.compile(r'^/AntimatterChat(/|$)')}


def domain_problem(host, path, scheme=True):
    host = host.lower()
    if host.endswith('.example') or host in ('example.com', 'example.org', 'example.net') or \
            re.search(r'\.example\.(com|org|net)$', host) or host in ALLOWED_HOSTS:
        return None
    if host in ALLOWED_PATHS and ALLOWED_PATHS[host].match(path or ''):
        return None
    if not scheme and not BARE_TLDS.search(host):
        return None
    return f'{host}{path or ""}'


def json_files():
    return sorted(FIXTURES.rglob('*.json'))


def walk(value, path=''):
    """Every (path, key, value) in a JSON document."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield path, k, v
            yield from walk(v, f'{path}/{k}')
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk(v, f'{path}[{i}]')


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


def problems_in(doc, name='fixture'):
    """What is wrong with one JSON document: a list of messages, empty when it is clean."""
    out = []
    for path, key, value in walk(doc):
        if isinstance(key, str) and SECRET_KEY.search(key) and not SECRET_KEY_OK.match(key):
            if value not in ('', None, [], {}, False, 0, '********'):
                out.append(f'{name}{path}/{key}: a secret-looking key has a value')
    for s in strings(doc):
        for m in EMAIL.finditer(s):
            domain = m.group(1).lower()
            # Not e-mail addresses: package scopes and versions (@mattermost/types, react@18.2).
            if '.' not in domain and domain != 'example':
                continue
            if re.fullmatch(r'[\d.]+', domain) or m.start() == 0 and s.startswith('@'):
                continue
            if domain not in EMAIL_DOMAINS:
                out.append(f'{name}: e-mail address outside the demo domains: {m.group(0)}')
        for m in PRIVATE_IP.finditer(s):
            out.append(f'{name}: private or local IP address: {m.group(0)}')
        for m in LOCAL_HOST.finditer(s):
            out.append(f'{name}: local host name: {m.group(0)}')
        for m in DOMAIN.finditer(s):
            bad = domain_problem(m.group(2), m.group(3), scheme=bool(m.group(1)))
            if bad:
                out.append(f'{name}: link to a real-looking domain: {bad[:80]}')
        if BEARER.search(s):
            out.append(f'{name}: bearer token or JWT')
        for p in PASSWORDS:
            if p in s:
                out.append(f'{name}: the demo accounts\' password')
    return out


class FixturesTest(unittest.TestCase):
    def test_fixtures_exist(self):
        self.assertTrue(json_files(), f'no fixtures in {FIXTURES}: run tools/demo/record_fixtures.py')

    def test_fixtures_are_clean(self):
        problems = []
        for f in json_files():
            try:
                doc = json.loads(f.read_text())
            except ValueError as e:
                problems.append(f'{f.relative_to(ROOT)}: not JSON ({e})')
                continue
            problems += problems_in(doc, str(f.relative_to(FIXTURES)))
        self.assertEqual(problems[:50], [], f'{len(problems)} problems')

    def test_no_text_files_with_secrets(self):
        # Other text files (none are expected) get the same string checks.
        for f in FIXTURES.rglob('*'):
            if f.is_file() and f.suffix in ('.txt', '.html', '.js', '.csv', '.md', '.svg'):
                self.assertEqual(problems_in(f.read_text(errors='replace'), str(f.relative_to(FIXTURES))), [])


class CheckerTest(unittest.TestCase):
    """The checks themselves catch what they must."""

    def test_catches_secrets(self):
        bad = {
            'user': {'email': 'maya@lumen.example', 'password': 'x'},
            'config': {'GiphySdkKey': 'abcdef', 'SiteURL': 'http://localhost:8067'},
            'post': {'message': 'see 192.168.1.20 or 10.0.0.1', 'props': {'token': 'pqrstuvwxyz'}},
            'hook': {'url': 'http://amdev-hooks:8069/x', 'auth': 'Bearer abcdefghijklmnop'},
            'mail': 'write to jason@gmail.com',
            'links': 'see https://github.com/lumen-labs/lumen-os/pull/1 and jira.lumenlabs.dev/browse/LUM-1',
            'pw': 'login with Antimatter-Local-1',
        }
        found = '\n'.join(problems_in(bad))
        for needle in ('/user/password', 'GiphySdkKey', 'lumen.example', 'localhost', '192.168.1.20', '10.0.0.1',
                       '/props/token', 'amdev-hooks', 'bearer', 'gmail.com', 'password', 'github.com/lumen-labs',
                       'jira.lumenlabs.dev'):
            self.assertIn(needle.lower(), found.lower(), needle)

    def test_accepts_clean_data(self):
        good = {
            'user': {'email': 'maya@lumenlabs.example', 'username': 'maya', 'id': 'xrcihg84tpbktq71599617cw6h'},
            'config': {'PasswordMinimumLength': '8', 'EnableUserAccessTokens': 'true', 'GiphySdkKey': '',
                       'SiteURL': '__SITE__'},
            'post': {'message': 'v1.2.3 ships with @mattermost/types and react@18; IP 8.8.8.8 is public; see '
                                'https://git.lumenlabs.example/lumen-labs/lumen-os, notes.md and window.location'},
            'links': ['https://antimatter.chat/help.html', 'https://github.com/AntimatterChat/desktop-app/releases',
                      'https://status.lumen.example', 'mailto:maya@lumenlabs.example'],
        }
        self.assertEqual(problems_in(good), [])


if __name__ == '__main__':
    unittest.main()
