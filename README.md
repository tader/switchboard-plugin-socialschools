# Social Schools for Switchboard

Connect your Social Schools account to [Switchboard](https://github.com/tader/switchboard) and use its authenticated HTTP API, API console, and MCP tools to access announcements, calendar events, conversations, teachers, and parent meeting schedules.

Install **`tader/switchboard-plugin-socialschools`** from **Plugins → Install from GitHub**. Requires Node.js 24 or later; no plugin dependencies or administrator OAuth registration are needed for standard web sign-in.

## Connect

1. Add a **Social Schools** connection and choose **Sign in with Social Schools**.
2. Under **Advanced**, set **Redirect URI** to `https://app.socialschools.eu/silent.html`.
3. Start sign-in. Sign in at Social Schools using your usual method. The return page is blank; copy its **full address**, including the query string.
4. Paste that address into the waiting Switchboard sign-in dialog. Switchboard validates the state, exchanges the PKCE code, and identifies your school role.

Parent/guardian is the default role. If your account belongs to several schools, set **School ID** in Advanced; school IDs are available in the Social Schools profile response (`/useraccounts/current`). Use separate connections for different school roles. The **Access token** method is also available for existing tokens.

**Standard web sign-in currently lasts about one hour.** The verified Social Schools web client does not issue a refresh token with its normal scopes. Reconnect when the token expires; remaining signed in to Social Schools generally makes this a short return-URL flow. This plugin does not store your password or browser cookies. A separately registered OAuth client can be configured in plugin settings; if its registration permits `offline_access`, enable **Request refresh tokens** to use automatic refresh. That custom-client configuration has unit coverage but has not been verified with a live registered client.

## Available operations

| Area | Operations |
| --- | --- |
| Account | Current profile, school roles, children, class/school groups |
| Announcements | Paginated feed, announcement details and attachment metadata |
| Calendar | Events in a date range and individual event details |
| Conversations | Inboxes, recipient search, conversation lists, message retrieval, send a reply, start a conversation |
| Parent meetings | Schedules, available slots and reservations, book/cancel a slot, choose meeting location |

Connections reject write requests by default. Enable **Allow messages and changes** when connecting if you want to send messages or change reservations. Social Schools may update read receipts on message retrieval even for a connection that blocks HTTP writes. Announcement read tracking is a separate endpoint, which the plugin does not call automatically.

The school chooses which modules and permissions are available to your role. This is an **unofficial integration with the web app's API**; upstream changes may require a plugin update. Messaging and booking request formats were checked against the app code, but no live writes were performed. See [the connection guide](docs/socialschools.md) for examples and booking details.

## Call through Switchboard

Get the connection reference from `GET /api/connections`. For example:

```bash
curl "$SWITCHBOARD_URL/api/call" \
  -H "Authorization: Bearer $SWITCHBOARD_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"connection\":\"$CONNECTION_REF\",\"method\":\"GET\",\"url\":\"communityposts?offset=0&limit=20&filterType=0\"}"
```

Relative paths resolve under `https://api.socialschools.eu/api/v1/`. Switchboard adds the bearer token and the selected school and role headers. Credentials are restricted to that API host. Attachment URLs are normally signed: download the returned URL directly without attaching the Social Schools bearer token.

The bundled OpenAPI reference exposes these operations to Switchboard's API console and MCP operation discovery. Responses retain Social Schools' field names and pagination cursors.

## Development and releases

```bash
npm run check
npm test
```

Tests mock authentication and cover PKCE/state, school selection, credential persistence, request restrictions, refresh rotation, and error redaction. Live read checks are described in [RESEARCH.md](RESEARCH.md); they require a real account and are not run in CI.

Release Please manages version/changelog PRs and GitHub releases. Package and plugin versions are updated together, and the API reference reads the plugin version. Release PRs explicitly dispatch the same required `test` check as normal changes. `main` requires pull requests, current passing CI, and resolved conversations, including for administrators.
