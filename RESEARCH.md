# Social Schools API research

Researched 2026-10-28 using public Social Schools application code and a user-authorized parent session. No private response values, account IDs, school IDs, messages, tokens, or browser profiles are included in this repository.

## Primary sources

- [Official website](https://www.socialschools.nl/)
- [Web app](https://app.socialschools.eu/), application asset `assets/index-491727fb.js`
- [OIDC metadata](https://login.socialschools.eu/.well-known/openid-configuration)
- Web-app modules `loader-f96f8bfd.js` (conversations), `index-9043747f.js` (recipient picker), `index-21658681.js` (parent meetings), `loader-e7325300.js` (callback handling), and `constants-4aa19646.js` (post states).

These assets were inspected for endpoint and request shapes; upstream application filenames change across deployments. No vendor implementation code is bundled.

## Authentication

The web client uses authorization code + PKCE S256, issuer `https://login.socialschools.eu`, client `eu.socialschools.webapp`, and scopes `openid SocsWebApi`. Its callbacks include `/callback.html` and `/silent.html` on `https://app.socialschools.eu`. The normal callback redirects away on an unknown OIDC state; the silent callback retains the return URL. This makes the silent callback usable with Switchboard's explicit redirect-URI override and manual return-URL completion.

The plugin's actual connect/callback implementation was exercised with that flow. Code exchange and profile identification succeeded. The token lifetime was 3,600 seconds, and no refresh token was issued. Custom registered clients and offline access were not available for live testing; those paths have mocked tests only.

Requests use `Authorization: Bearer …`, `Schoolid`, and `Roletypeid`; parent is role type 1, employee 2, student 3. School context is selected from the authenticated profile, rather than trusting an unchecked school field.

## Live verification

The plugin itself successfully authorized GET requests returning HTTP 200 for:

- `useraccounts/current`
- `communities?showAll=true`
- `communityposts` and an individual announcement
- `events` and an individual event
- `inboxes` and `inboxes/{inboxId}/topics`
- `recipients` with inbox and employee-role filters
- `meetings/sets/parents`

During browser exploration, an inspector blocked non-GET/HEAD/OPTIONS requests to the API and statistics host, including automatic POSTs to `statistics.socialschools.eu/api/PostsSeenBy`. Only field structures were retained from API responses. The plugin's live verification fetched no conversation messages because retrieval may update read receipts. No messages, RSVPs, bookings, cancellations, or location changes were submitted.

## Writes checked from app code

- New message: POST `inboxes/{inboxId}/topics/{topicId}/messages`, JSON `body`, `media`, `postMedia`.
- New conversation: POST `inboxes/{inboxId}/topics`, plus `title`, `participants` (`id`, `roleType`), `topicType=1`, `status=30` (send immediately).
- Slot reservation: PUT `meetings/sets/{setId}/timeslots/{slotId}`, preserving the current slot fields and `timestamp`; assigned is status 3 with a meeting ID, unassigned is status 0 with a null meeting ID.
- Location: PUT `meetings/sets/{setId}/meetings/{meetingId}/meetingLocationType`, values 1 (in person) or 2 (video).

The reservation UI can prompt before replacing an existing slot and can change the location first. API consumers must account for both. These writes remain unverified against the live service.
