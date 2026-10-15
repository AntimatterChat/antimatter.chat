"""The comparison tables: Antimatter and common chat apps, feature by feature.

Each value is (state, note): state is 'yes', 'part' or 'no'; the note says what limits a "part" (a paid plan, an
add-on, a plugin...). Keep it to what the vendors document publicly, and conservative when unsure.
"""

APPS = {
    'slack': 'Slack',
    'mattermost': 'Mattermost',
    'rocketchat': 'Rocket.Chat',
    'discord': 'Discord',
    'teams': 'Microsoft Teams',
    'element': 'Element (Matrix)',
}

Y, P, N = 'yes', 'part', 'no'

# (group, feature, {app: (state, note)}); 'antimatter' is first.
ROWS = [
    ('Hosting and licensing', 'Self-hosted on your own servers', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (Y, ''), 'rocketchat': (Y, ''), 'discord': (N, ''), 'teams': (N, ''), 'element': (Y, '')}),
    ('Hosting and licensing', 'Open-source server', {
        'antimatter': (Y, 'AGPL v3'), 'slack': (N, ''), 'mattermost': (P, 'enterprise features are proprietary'),
        'rocketchat': (P, 'enterprise features are proprietary'), 'discord': (N, ''), 'teams': (N, ''), 'element': (P, 'enterprise features are proprietary')}),
    ('Hosting and licensing', 'Every feature without a paid plan', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (N, ''), 'rocketchat': (N, ''),
        'discord': (P, 'perks with Nitro'), 'teams': (N, ''), 'element': (N, '')}),
    ('Hosting and licensing', 'Runs offline, without internet access', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (Y, ''), 'rocketchat': (Y, ''), 'discord': (N, ''), 'teams': (N, ''), 'element': (Y, '')}),

    ('Messaging', 'Channels, direct messages and threads', {
        'antimatter': (Y, ''), 'slack': (Y, ''), 'mattermost': (Y, ''), 'rocketchat': (Y, ''), 'discord': (Y, ''), 'teams': (Y, ''), 'element': (Y, '')}),
    ('Messaging', 'Unlimited message history', {
        'antimatter': (Y, ''), 'slack': (P, 'limited on the free plan'), 'mattermost': (Y, ''), 'rocketchat': (Y, ''),
        'discord': (Y, ''), 'teams': (Y, ''), 'element': (Y, '')}),
    ('Messaging', 'Scheduled messages and reminders', {
        'antimatter': (Y, ''), 'slack': (Y, ''), 'mattermost': (Y, ''), 'rocketchat': (P, 'reminders through apps'),
        'discord': (N, ''), 'teams': (Y, ''), 'element': (N, '')}),
    ('Messaging', 'Message priority and acknowledgements', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (P, 'acknowledgements on paid plans'), 'rocketchat': (N, ''),
        'discord': (N, ''), 'teams': (P, 'urgent messages, no acknowledgements'), 'element': (N, '')}),
    ('Messaging', 'Self-destructing (burn-on-read) messages', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (P, 'Enterprise Advanced'), 'rocketchat': (N, ''),
        'discord': (N, ''), 'teams': (N, ''), 'element': (N, '')}),
    ('Messaging', 'Automatic translation of channels', {
        'antimatter': (Y, 'self-hosted models'), 'slack': (N, ''), 'mattermost': (P, 'Enterprise Advanced'),
        'rocketchat': (P, 'with a translation provider'), 'discord': (N, ''), 'teams': (Y, ''), 'element': (N, '')}),

    ('Calls', 'Voice and video calls with screen sharing', {
        'antimatter': (Y, ''), 'slack': (P, '1:1 only on the free plan'), 'mattermost': (Y, ''),
        'rocketchat': (P, 'through a conference app'), 'discord': (Y, ''), 'teams': (Y, ''), 'element': (Y, 'Element Call')}),
    ('Calls', 'Always-open voice channels', {
        'antimatter': (Y, ''), 'slack': (P, 'huddles'), 'mattermost': (N, ''), 'rocketchat': (N, ''), 'discord': (Y, ''), 'teams': (N, ''), 'element': (P, 'video rooms, experimental')}),
    ('Calls', 'Live captions and call transcripts', {
        'antimatter': (Y, 'your own speech-to-text'), 'slack': (P, 'paid plans'), 'mattermost': (P, 'Enterprise'),
        'rocketchat': (N, ''), 'discord': (N, ''), 'teams': (P, 'depends on the license'), 'element': (N, '')}),

    ('Apps and AI', 'Collaborative notes and documents', {
        'antimatter': (Y, ''), 'slack': (Y, 'canvases'), 'mattermost': (N, ''), 'rocketchat': (N, ''), 'discord': (N, ''),
        'teams': (Y, 'Loop'), 'element': (N, '')}),
    ('Apps and AI', 'Whiteboards', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (N, ''), 'rocketchat': (N, ''), 'discord': (N, ''), 'teams': (Y, ''), 'element': (N, '')}),
    ('Apps and AI', 'Kanban boards', {
        'antimatter': (Y, ''), 'slack': (P, 'lists'), 'mattermost': (P, 'community plugin'), 'rocketchat': (N, ''),
        'discord': (N, ''), 'teams': (P, 'Planner'), 'element': (N, '')}),
    ('Apps and AI', 'Incident and process checklists', {
        'antimatter': (Y, ''), 'slack': (P, 'workflows'), 'mattermost': (Y, 'Playbooks'), 'rocketchat': (N, ''),
        'discord': (N, ''), 'teams': (P, 'through Power Automate'), 'element': (N, '')}),
    ('Apps and AI', 'Polls', {
        'antimatter': (Y, ''), 'slack': (P, 'through apps'), 'mattermost': (P, 'plugin'), 'rocketchat': (P, 'through apps'),
        'discord': (Y, ''), 'teams': (Y, ''), 'element': (Y, '')}),
    ('Apps and AI', 'AI assistants with the models you choose, self-hosted included', {
        'antimatter': (Y, ''), 'slack': (P, 'paid add-on, vendor models'), 'mattermost': (P, 'paid plans'),
        'rocketchat': (P, 'paid plans'), 'discord': (N, ''), 'teams': (P, 'Copilot, paid add-on'), 'element': (N, '')}),

    ('Security and administration', 'Single sign-on (SAML, OpenID Connect)', {
        'antimatter': (Y, ''), 'slack': (P, 'paid plans'), 'mattermost': (P, 'paid plans'), 'rocketchat': (Y, ''),
        'discord': (N, ''), 'teams': (Y, 'Microsoft Entra'), 'element': (Y, '')}),
    ('Security and administration', 'LDAP and Active Directory sync', {
        'antimatter': (Y, ''), 'slack': (N, ''), 'mattermost': (P, 'paid plans'), 'rocketchat': (P, 'advanced sync on paid plans'),
        'discord': (N, ''), 'teams': (Y, 'Microsoft Entra'), 'element': (P, 'sync in the paid server suite')}),
    ('Security and administration', 'Data retention and compliance export', {
        'antimatter': (Y, ''), 'slack': (P, 'Enterprise'), 'mattermost': (P, 'Enterprise'), 'rocketchat': (P, 'paid plans'),
        'discord': (N, ''), 'teams': (P, 'depends on the license'), 'element': (P, 'compliance tools in the paid server suite')}),
    ('Security and administration', 'Federation with other servers', {
        'antimatter': (Y, 'shared channels'), 'slack': (P, 'Slack Connect, paid plans'), 'mattermost': (P, 'Enterprise'),
        'rocketchat': (Y, 'Matrix'), 'discord': (N, ''), 'teams': (P, 'external access'), 'element': (Y, 'Matrix')}),
    ('Security and administration', 'End-to-end encryption of messages', {
        'antimatter': (N, ''), 'slack': (N, ''), 'mattermost': (N, ''), 'rocketchat': (Y, ''), 'discord': (P, 'calls only'),
        'teams': (P, 'one-to-one calls'), 'element': (Y, '')}),
]

# What each page says about the other app: where it may suit you better, honestly.
NOTES = {
    'slack': {
        'lead': 'Slack is the best-known team chat. It runs only in Slack\'s cloud, and much of it is behind paid plans.',
        'better': [
            'You don\'t want to run a server at all.',
            'You rely on apps from Slack\'s large directory that have no Antimatter or Mattermost equivalent.',
            'You work with many outside organisations that are already on Slack.',
        ],
        'ours': [
            'Your messages and files stay on your own servers, and the whole server is open source.',
            'Everything is included: no per-seat price, no SSO tax, no message history limit, no paid AI add-on.',
            'Voice channels, whiteboards and notes come built in, and AI works with your own models.',
        ],
    },
    'mattermost': {
        'lead': 'Antimatter is a fork of Mattermost: it keeps its server, its APIs and its integrations. What differs is the licensing, the interface and the apps.',
        'better': [
            'You want commercial support, with SLAs, from the company that makes the software.',
            'You need certified builds, such as FIPS 140-3 or STIG-hardened images.',
            'You need features Antimatter hasn\'t got yet, such as high-availability clustering tested at large scale or legal hold.',
        ],
        'ours': [
            'Every feature is free software under the AGPL: SSO, LDAP sync, compliance export, data retention and the rest come with every server.',
            'A new interface, with voice channels, roles and badges, onboarding and moderation tools.',
            'Built-in notes, whiteboards, todo lists, calendar and mail, and AI transcription without extra services.',
            'It keeps Mattermost\'s APIs, so integrations written for Mattermost keep working.',
        ],
    },
    'rocketchat': {
        'lead': 'Rocket.Chat is another open-source, self-hostable chat, with a focus on omnichannel customer service and federation.',
        'better': [
            'You need end-to-end encrypted messages.',
            'You want omnichannel live chat with your customers (website chat, email, social messaging) in the same tool.',
            'You want to federate with the Matrix network.',
        ],
        'ours': [
            'A proven server, with fine-grained permissions, a complete API and plugins.',
            'All features included, with no enterprise edition.',
            'Voice channels, calls with live captions, notes, whiteboards, kanban and playbooks built in.',
        ],
    },
    'discord': {
        'lead': 'Discord popularised voice channels and community servers. It is built for communities and gaming, and runs only in Discord\'s cloud.',
        'better': [
            'You run a large public community and want people to join with the account they already have.',
            'You want Discord\'s activities, streaming to large audiences and its app ecosystem.',
        ],
        'ours': [
            'The parts people love about Discord, such as voice channels, roles, badges and onboarding, on a server you own.',
            'Made for work too: threads, single sign-on, compliance, integrations and AI with your own models.',
            'No tracking and no advertising: your community\'s data stays with you.',
        ],
    },
    'teams': {
        'lead': 'Microsoft Teams comes with Microsoft 365. It is deeply tied to Microsoft\'s cloud and licensing.',
        'better': [
            'Your organisation lives in Microsoft 365, SharePoint and Outlook already.',
            'You need large meetings, webinars and telephony from one vendor.',
        ],
        'ours': [
            'Self-hosted and open source, with no dependency on a single vendor\'s cloud.',
            'A fast chat-first interface with voice channels, threads and built-in apps.',
            'AI, transcription and translation with the models you choose, with no add-on license.',
        ],
    },
    'element': {
        'lead': 'Element is the best-known app of Matrix, an open, federated protocol for secure chat. Its server can be self-hosted, with a paid suite for larger organisations.',
        'better': [
            'You need end-to-end encryption by default, everywhere.',
            'You want to federate with the open Matrix network, or bridge to other chat networks.',
            'You work with organisations that have standardised on Matrix.',
        ],
        'ours': [
            'Built for teams and communities alike: threads, voice channels, roles and badges, onboarding and moderation tools.',
            'Apps built in: notes, whiteboards, kanban, playbooks, polls and todo lists, plus AI and call transcripts with your own models.',
            'Every feature included, with no paid server edition.',
        ],
    },
}
