const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3210);
const HOST = "127.0.0.1";
const REDIRECT_URI = `http://${HOST}:${PORT}/oauth2/callback`;
const TOKEN_PATH = path.join(ROOT, "google-tokens.json");
const OAUTH_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
const pendingOAuthStates = new Map();

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnv();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end();
}

function expectedOrigin() {
  return `http://${HOST}:${PORT}`;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function getStoredTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Could not read the local Google token file.");
  }
}

function saveTokens(tokens) {
  const tempPath = `${TOKEN_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, TOKEN_PATH);
}

async function getAccessToken() {
  const tokens = getStoredTokens();
  if (!tokens || (!tokens.refresh_token && !tokens.access_token)) {
    throw new Error("Connect Gmail before sending an email.");
  }
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error("Gmail access expired. Reconnect Gmail.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const updated = await response.json();
  if (!response.ok || !updated.access_token) {
    throw new Error(`Could not refresh Gmail access: ${updated.error_description || updated.error || response.statusText}`);
  }
  const nextTokens = { ...tokens, ...updated, refresh_token: tokens.refresh_token, expiry_date: Date.now() + updated.expires_in * 1000 };
  saveTokens(nextTokens);
  return nextTokens.access_token;
}

function safeText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const cleaned = value.trim();
  if (cleaned.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return cleaned;
}

async function route(request, response) {
  const url = new URL(request.url, expectedOrigin());

  if (request.method === "GET" && url.pathname === "/api/status") {
    let tokens;
    try {
      tokens = getStoredTokens();
    } catch (error) {
      return sendJson(response, 500, { error: error.message });
    }
    return sendJson(response, 200, {
      braveConfigured: Boolean(process.env.BRAVE_SEARCH_API_KEY && !process.env.BRAVE_SEARCH_API_KEY.startsWith("replace_")),
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET &&
        !process.env.GOOGLE_CLIENT_ID.startsWith("replace_") && !process.env.GOOGLE_CLIENT_SECRET.startsWith("replace_")),
      googleConnected: Boolean(tokens && (tokens.refresh_token || tokens.access_token))
    });
  }

  if (request.method === "GET" && url.pathname === "/api/auth/google") {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET ||
        process.env.GOOGLE_CLIENT_ID.startsWith("replace_") || process.env.GOOGLE_CLIENT_SECRET.startsWith("replace_")) {
      return sendJson(response, 503, { error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first." });
    }
    const state = crypto.randomBytes(32).toString("hex");
    pendingOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: OAUTH_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state
    }).toString();
    return redirect(response, authorization.toString());
  }

  if (request.method === "GET" && url.pathname === "/oauth2/callback") {
    const state = url.searchParams.get("state");
    const expiresAt = pendingOAuthStates.get(state);
    pendingOAuthStates.delete(state);
    if (!state || !expiresAt || expiresAt < Date.now()) {
      return sendJson(response, 400, { error: "Google sign-in could not be verified. Please reconnect." });
    }
    if (url.searchParams.has("error")) {
      return redirect(response, "/?gmail=cancelled");
    }
    const code = url.searchParams.get("code");
    if (!code) return sendJson(response, 400, { error: "Google did not return an authorization code." });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) {
      console.error("Google OAuth token exchange failed:", tokens.error || tokenResponse.statusText);
      return sendJson(response, 502, { error: "Google sign-in failed while exchanging the authorization code. Check the OAuth setup and try again." });
    }
    const previousTokens = getStoredTokens() || {};
    saveTokens({
      ...previousTokens,
      ...tokens,
      refresh_token: tokens.refresh_token || previousTokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000
    });
    return redirect(response, "/?gmail=connected");
  }

  if (request.method === "POST" && ["/api/search", "/api/send"].includes(url.pathname)) {
    if (request.headers.origin !== expectedOrigin()) {
      return sendJson(response, 403, { error: "Request origin was not recognized. Open ClientReach from its local server URL." });
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    if (url.pathname === "/api/search") {
      if (!process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_SEARCH_API_KEY.startsWith("replace_")) {
        return sendJson(response, 503, { error: "Add your Brave Search API key to .env and restart ClientReach." });
      }
      let query;
      try {
        query = safeText(body.query, "Search phrase", 300);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
      try {
        const searchUrl = new URL("https://api.search.brave.com/res/v1/web/search");
        searchUrl.search = new URLSearchParams({ q: query, count: "8" }).toString();
        const result = await fetch(searchUrl, {
          headers: { "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY, Accept: "application/json" }
        });
        const data = await result.json();
        if (!result.ok) {
          console.error("Brave Search API returned", result.status, data.error || data.message || "");
          return sendJson(response, result.status === 401 || result.status === 403 ? 502 : 502, {
            error: "Brave Search could not complete the request. Check the API key and plan in your Brave dashboard."
          });
        }
        const results = (data.web && Array.isArray(data.web.results) ? data.web.results : []).map(item => ({
          title: String(item.title || "").slice(0, 300),
          url: String(item.url || ""),
          description: String(item.description || "").slice(0, 1200)
        })).filter(item => {
          try { return item.title && item.description && ["http:", "https:"].includes(new URL(item.url).protocol); }
          catch { return false; }
        });
        return sendJson(response, 200, { query, results });
      } catch (error) {
        console.error("Brave Search request failed:", error.message);
        return sendJson(response, 502, { error: "Could not reach Brave Search. Check your internet connection and try again." });
      }
    }

    let to;
    let subject;
    let message;
    try {
      to = safeText(body.to, "Recipient email", 320);
      subject = safeText(body.subject, "Subject", 250);
      message = safeText(body.body, "Message", 20_000);
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new Error("Enter a valid recipient email address.");
      if (/[\r\n]/.test(subject) || /[\r\n]/.test(to)) throw new Error("Email headers contain invalid line breaks.");
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    try {
      const accessToken = await getAccessToken();
      const encodedMessage = Buffer.from([
        `To: ${to}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(message, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trim()
      ].join("\r\n"), "utf8").toString("base64url");
      const gmailResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: encodedMessage })
      });
      const result = await gmailResponse.json();
      if (!gmailResponse.ok) {
        console.error("Gmail API send failed:", gmailResponse.status, result.error && result.error.message);
        return sendJson(response, 502, { error: "Gmail did not send the message. Reconnect Gmail or check the recipient and Google account." });
      }
      return sendJson(response, 200, { sent: true, messageId: result.id });
    } catch (error) {
      console.error("Gmail send request failed:", error.message);
      return sendJson(response, 502, { error: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    });
    return fs.createReadStream(path.join(ROOT, "index.html")).pipe(response);
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  response.end("Not found");
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    console.error("Request failed:", error.message);
    if (!response.headersSent) sendJson(response, 500, { error: "An unexpected local server error occurred." });
    else response.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ClientReach is running at http://${HOST}:${PORT}`);
  console.log("Keep this terminal open while using the app. Press Ctrl+C to stop.");
});

server.on("error", error => {
  console.error(`Could not start ClientReach on ${HOST}:${PORT}: ${error.message}`);
  process.exitCode = 1;
});
