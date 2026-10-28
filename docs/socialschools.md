---
title: Connecting Social Schools
services: [socialschools]
order: 1
---

# Connecting Social Schools

Add a Social Schools connection. Choose **Sign in with Social Schools**, open **Advanced**, and set **Redirect URI** to:

```text
https://app.socialschools.eu/silent.html
```

Sign in at Social Schools. When the blank return page appears, copy the complete address and paste it into Switchboard's waiting dialog. The address contains a short-lived sign-in code; paste it only into the sign-in dialog. The plugin uses PKCE and checks the sign-in state before exchanging that code.

The standard web client issues a token lasting about one hour without a refresh token. Reconnect when it expires. Administrators with a separately registered client may configure it in plugin settings; its registered Switchboard callback is `{{callbackUrl}}`. Only enable refresh tokens if that client permits `offline_access`.

The default role is **Parent/guardian**. For multiple schools, enter a **School ID** in Advanced and create a connection per school role. An **Access token** connection can be used to read `/useraccounts/current` with an explicitly selected school if needed; the official app's profile response also contains `roles[].school.id`.

## Read announcements and events

Use the API console or MCP operation discovery:

```http
GET communityposts?offset=0&limit=20&filterType=0
GET communityposts/{postId}
GET events?from=2026-11-01T00:00:00Z&until=2026-12-01T00:00:00Z
GET events/{eventId}
```

Feed responses contain `values`, `totalCount`, and `timeStamp`. Reuse `timeStamp` while incrementing `offset`. Use explicit time zones in event ranges. Attachment URLs returned by Social Schools may be signed and expire; download them without adding your account token.

## Conversations

```http
GET inboxes
GET recipients?inboxId={inboxId}&connectionRoleType=2&offset=0&limit=20
GET inboxes/{inboxId}/topics?offset=0&limit=20
GET inboxes/{inboxId}/topics/{topicId}/messages?offset=0&limit=20
```

`connectionRoleType=2` selects employees; `1` selects parents and `3` selects students. Add `q` to search. Keep recipient `id` and `roleType` together; profile IDs and email addresses are not recipient IDs. Some schools use shared classroom inboxes. Returned `nextUrl`/`nextSince` values are pagination cursors; only follow URLs on the Social Schools API host.

> [!NOTE]
> Retrieving messages may update read receipts at Social Schools. Blocking HTTP writes does not prevent server-side effects of a GET.

Enable **Allow messages and changes** to reply:

```http
POST inboxes/{inboxId}/topics/{topicId}/messages
Content-Type: application/json

{"body":"Your message here","media":[],"postMedia":[]}
```

To start a conversation:

```http
POST inboxes/{inboxId}/topics
Content-Type: application/json

{"title":"Subject","body":"Your message here","participants":[{"id":123,"roleType":2}],"topicType":1,"status":30,"media":[],"postMedia":[]}
```

These send immediately. Replace the example participant with an actual recipient from `recipients`. After a timeout, check the conversation before retrying to avoid duplicates. Sending was verified from app request code and unit-tested through the plugin authorization gate; no live messages were sent.

## Parent meeting reservations

```http
GET meetings/sets/parents
```

Each schedule contains `meetings` and `blocks[].timeslots`. Match `timeslot.meetingId` to `meetings[].id`; the meeting's `studentId` identifies the child. An assigned slot has status `3`. Status `0` means open, `1` break, and `2` blocked. Also check `available`, `locked`, registration dates, and existing reservations.

To book, PUT the selected slot to `meetings/sets/{setId}/timeslots/{slotId}`, keeping `id`, `blockId`, `start`, `end`, and the exact current `timestamp`. Set `meetingId` to that child's meeting ID and `status` to `3`. To cancel, send the same slot fields with `meetingId: null` and `status: 0`. A booking can replace the child's existing reservation. Never change a locked slot; re-read after HTTP 409 or 410 instead of retrying stale data.

When parents can choose a location, first PUT `{"meetingLocationType":1}` (in person) or `{"meetingLocationType":2}` (video) to `meetings/sets/{setId}/meetings/{meetingId}/meetingLocationType`, then update the slot. Location changes and reservations require **Allow messages and changes**.

Booking and location request schemas were checked against the app, but no live reservations were changed. Use the official app if your school requires a flow this API reference does not cover.
