# Privacy Policy — Play Sequence Override

**Controller:** winsrewu · **Contact:** winsrewu@jawbts.org · **Last updated:** 2026-11-01

Play Sequence Override is a browser extension (Microsoft Edge / Chromium) that
replaces a site's own playback order with a recommender. This policy explains
what the extension does with your data. It applies to the extension and to the
optional embedding service described below; it does not apply to websites you
visit or to services you configure yourself. A Chinese translation is provided
in [PRIVACY.zh-CN.md](PRIVACY.zh-CN.md); if the two versions differ, this English
version governs.

## Who we are

The extension and the default hosted embedding service at `*.jawbts.org` are
published and operated by **winsrewu**, an individual developer. If you change
the API, gateway or embedding URLs in the settings, those services are operated
by whoever runs them, not by us, and their own policies apply.

## Summary

- The extension works on Bilibili video pages. Signing in through the
  configured OAuth gateway is **optional** — it is only needed to fetch missing
  embeddings automatically from the API — and the resulting session is stored on
  your device.
- Your session, settings, imported library, embeddings and playback history are
  stored locally in your browser (IndexedDB). They are not sent to us.
- If you use the hosted embedding service, it receives only the request itself:
  your IP address, the video id, your bearer token and timestamps. It keeps no
  library, vectors, history or account profile.
- There is no analytics, telemetry, advertising, tracking or selling of data,
  and no automated decision-making with legal effects.

## Data the extension handles

| Data | Examples | Where it lives | Why |
| --- | --- | --- | --- |
| Authentication information (only if you sign in) | OAuth access and refresh tokens, account subject, granted scopes, expiry | IndexedDB on your device | Authorize calls to your configured API |
| Your library | Track ids, titles, pages, 960-dimension audio vectors that you import or fetch | IndexedDB on your device | Let the recommender pick tracks without re-downloading them |
| Playback state | Current track, recent history, play counts, last decision | IndexedDB on your device | Sequence playback and apply the "recently played" penalty |
| Settings | API/gateway/embedding URLs, target similarity, tuning, auto-advance | IndexedDB on your device | Remember your preferences |

The extension also reads the Bilibili video page you have open (player state and
page title) and asks `api.bilibili.com` for the video's `aid`/`cid`/page list so
it can switch videos without a full reload. That metadata is used in place and
is not stored beyond the identifiers above.

You can use the extension without an account: import a playlist and the
embedding files yourself and nothing needs to sign in. Providing this data is
not required by law or by contract — without sign-in the extension still
sequences playback, but automatic vector fetching is unavailable until you
import embeddings yourself.

## Data we never collect

- Name, address, email address, age or any government identifier
- Health, financial or payment information
- Private messages, emails, texts or other personal communications
- Location data (no GPS and no IP-based geolocation in the extension itself)
- Keystrokes, mouse movement, clicks, scrolling or other input monitoring
- Your general browsing history — only Bilibili video pages where you use the
  extension are involved
- Page content such as images, audio or video: the extension sends only the
  video **id** to the embedding service, which fetches the audio itself

We do not build advertising profiles and do not make automated decisions with
legal or similarly significant effects.

## Where data goes

1. **Your configured API and gateway** (by default `*.jawbts.org`, operated by
   us): the OAuth sign-in (if you choose to sign in), token refresh, and the
   embedding request carrying the video id and your bearer token.
2. **Bilibili**: the page you have open and requests for video metadata made by
   the extension; audio downloads are made by the embedding service, not by your
   browser.

Nothing else leaves your device. When you use the hosted service, the request
itself — IP address, video id, bearer token, timestamps — reaches us and may
appear in the operational logs described below. We do not receive your library,
playback history, imported files or account profile.

## Consent for remote services

Before the extension signs in or fetches vectors from a service that is not on
your own machine, **Settings & allowlist** asks for your consent to send request
data (IP address, video id and token) to those remote services, which may be
outside your country. The grant is stored locally with the origins it covers and
a timestamp; it stops applying if you change the configured services. Untick the
box at any time to revoke it. Without consent the extension does not contact
remote services — you can still import vectors from files and use playback
sequencing.

## The embedding service

The optional backend exposes one route, `POST /v1/embed`. For each request it
verifies the signed token, downloads the requested audio, computes a
960-dimension vector and deletes the temporary audio. It keeps no catalog,
vectors, history, playback state or user profile. Standard operational logs
(request path, status code, client address, timestamps) may be produced for
security and debugging; the account subject is not logged, the audio is not
retained, and operational logs have no automatic expiry: they are kept for as
long as the service runs.

## Hosted instances and infrastructure providers

If you point the extension at a hosted embedding service instead of your own
deployment, that service runs on third-party infrastructure. The hosted instance
is currently served through Cloudflare (DNS, TLS, proxying) and runs on Alibaba
Cloud (Aliyun) machines. Those providers may process connection-level data —
your IP address, request headers, request path and timestamps — while delivering
the traffic, protecting the service and preventing abuse, under their own
privacy policies.

They do not receive your audio, account subject, library or playback history:
the audio is fetched and deleted per request, and none of the rest is stored
server-side. If you prefer not to involve those providers at all, deploy the
service yourself (see Deploy in the README) and point the extension at your own
URL in **Settings & allowlist**.

## Legal bases (EEA / UK)

Where the GDPR or UK GDPR applies, we rely on:

- **Performance of a contract** (Art. 6(1)(b)) for sign-in, token handling and
  the embedding request you ask for;
- **Legitimate interests** (Art. 6(1)(f)) for security, abuse prevention and
  short-lived operational logs, limited to what is necessary for those purposes;
- **Consent** (Art. 6(1)(a)) for anything optional you switch on — including the
  transfer consent below — which you can withdraw at any time by unticking it,
  disconnecting or uninstalling.

We do not process special categories of personal data.

## International transfers

Cloudflare and Alibaba Cloud may process connection data outside your country.
Where a transfer from the EEA or UK is involved, we rely on Cloudflare's
Customer Data Processing Addendum and Alibaba Cloud's Data Processing Addendum,
including their EEA/UK addenda that incorporate the Standard Contractual
Clauses ([Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/),
[Alibaba Cloud DPA](https://www.alibabacloud.com/help/en/legal/latest/giehfb)). In mainland China,
using the hosted instance involves a cross-border transfer of request data; PIPL
may require your separate consent for it. If you do not consent to that transfer,
use your own deployment as described above. If you configure services run by
someone else, their transfer arrangements apply instead.

## Your rights

Depending on where you live, you may have the right to access, correct, delete or
receive a copy of your personal data, to restrict or object to processing, to
withdraw consent, and to lodge a complaint with a supervisory authority (EEA/UK)
or the competent authority (mainland China). Under the CCPA/CPRA you may know,
delete, correct, and opt out of sale or sharing — we do neither.

Almost everything is on your device, so you can exercise most of these directly:
**Disconnect** deletes the session, **Clear history** deletes playback history,
**Settings & allowlist → Reset** restores defaults, and uninstalling removes the
extension's storage. For anything else, or for server-side requests, email
**winsrewu@jawbts.org**; we may ask for enough information to identify the request,
and we answer within the time required by applicable law.

## Retention

- Local data: until you delete it or uninstall the extension.
- Hosted service: operational logs have no automatic expiry and are kept for as
  long as the service runs; audio is deleted immediately after the vector is
  computed.
- There is no server-side account, library, vector store or playback history to
  retain.

## Storage and deletion controls

- **Disconnect** in the popup deletes the stored session.
- **Clear history** in the popup deletes the playback history.
- Uninstalling the extension removes its IndexedDB storage.
- Settings can be reset to defaults in **Settings & allowlist**.

Accounts themselves belong to the OAuth provider you signed in with. OS-level or
browser backups you create may retain copies of extension data on your own
devices; those copies are outside our control.

## Permissions and why they are needed

- `storage` — read and clear data written by earlier versions of the extension
  during the one-time migration into IndexedDB.
- `unlimitedStorage` — hold a normal-sized library (thousands of tracks and
  their vectors) in IndexedDB without hitting the extension quota.
- `identity` — optional OAuth sign-in via
  `chrome.identity.launchWebAuthFlow`; the extension never sees your password.
- `alarms` — resume fetching missing vectors if the service worker is suspended
  mid-run.
- `scripting` — run the playback watcher on Bilibili video tabs and switch to the
  next video without a full reload.
- Host access to `*.jawbts.org`, `www.bilibili.com` and `api.bilibili.com` —
  the API/gateway calls, the playback page and the video metadata. `localhost`
  and `127.0.0.1` are for a local development server. Broader `https://*/*`
  access is optional and requested only if you configure a self-hosted API from
  the settings page.

## Security

Tokens and library data are kept in the extension's own IndexedDB origin, which
other websites cannot read. The extension loads only scripts packaged with it and
does not execute remote code. No method of storage or transmission is completely
secure; if a breach ever affects your data, we will notify you and the competent
authority as required by law.

## Children

The extension is not directed to children. In the EEA/UK the minimum age is 16
unless your country sets a lower age (not below 13); in mainland China, users
under 14 need verifiable guardian consent. We do not knowingly collect data from
children, and if you believe a child has provided data, contact us so we can
remove it.

## United States (CCPA / CPRA)

We do not sell or share personal information as those terms are defined by the
CCPA/CPRA, and we do not use it for cross-context behavioural advertising. The
extension stores authentication information and playback history locally on your
device; the hosted service receives only the request data described above, and
our infrastructure providers process it on our behalf as service providers. You
have the rights listed under “Your rights” and will not be discriminated against
for exercising them.

## Limited Use

The extension uses data solely to provide its single purpose — sequencing
playback — and to authenticate you with the API you configure. Its use of
information received from Chrome APIs adheres to the Chrome Web Store User Data
Policy, including the Limited Use requirements. It does not use or transfer data
for advertising, for determining creditworthiness, or for any purpose unrelated
to that single purpose, and it does not sell data or share it with third parties
other than the services you configure.

## Changes

We will update this policy when our practices change and revise the “Last
updated” date above. Material changes will be announced on the extension's
listing page; continued use after an update means the updated policy applies.

## Contact

**winsrewu@jawbts.org**
