# ClientReach

ClientReach is a local-first prospect research and email drafting app. It can search public web results through Brave Search and send one email at a time through your Gmail account, after you review the message and confirm the send.

## Requirements

- Node.js 20 or newer
- A Brave Search API key
- A Google OAuth client for Gmail

The app has no npm package dependencies. The server listens only on `127.0.0.1` and serves the app locally.

## Configure web search

1. Create a Brave Search API key in your Brave Search API dashboard.
2. Copy `.env.example` to `.env` in this folder.
3. Replace `BRAVE_SEARCH_API_KEY` with your key.

## Configure Gmail

1. In Google Cloud Console, create or choose a project and enable the Gmail API.
2. Configure the OAuth consent screen. If the app is in testing mode, add the Gmail account you will use as a test user.
3. Create an OAuth client ID of type **Web application**.
4. Add this authorized redirect URI exactly: `http://127.0.0.1:3210/oauth2/callback`
5. Put the OAuth client ID and client secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
6. Save the file. Do not share `.env` or `google-tokens.json`; both are excluded from Git.

ClientReach requests the `gmail.send` permission plus basic identity scopes for OAuth. Gmail access and refresh tokens are stored in the local `google-tokens.json` file.

## Start

Open PowerShell or a terminal in this folder and run:

```text
npm start
```

Then open <http://127.0.0.1:3210>. Keep the terminal window running while you use ClientReach. Press `Ctrl+C` in that window to stop it.

## Use

1. Save your service, target client, location, and truthful proof points.
2. Search with an industry/location phrase. Open the result and verify the business and its public information.
3. Use a result to pre-fill a prospect, then provide a real contact name, public business email, and a specific accurate observation.
4. Select the prospect, edit the draft, confirm the recipient and full message, then click **Send with Gmail**. Each message requires its own confirmation; there is no bulk-send feature.
5. Track outreach status and export your list to CSV for a backup.

Sending happens through the connected Gmail account, not through the browser's default mail app. A successful send is recorded as `contacted`. Search results may be incomplete or inaccurate; the app does not verify contacts or invent email addresses. Contact only relevant recipients, comply with applicable email/privacy laws, and honor opt-out requests.

## Local data and troubleshooting

Your profile and prospects stay in this browser's local storage. Search phrases/results are sent to Brave Search; Gmail sends only the recipient, subject, and message you approved. OAuth credentials and tokens stay in local files. Export a CSV backup before clearing browser data.

- If integrations are unavailable, check `.env` and restart the server.
- If Gmail cannot connect, confirm that the Gmail API is enabled, the OAuth redirect URI matches exactly, and the account is an allowed test user when the consent screen is in testing.
- To disconnect Gmail, stop the server and delete `google-tokens.json`.
- If port 3210 is already in use, set `PORT` in `.env` and change the redirect URI in Google Cloud to `http://127.0.0.1:<port>/oauth2/callback`.
