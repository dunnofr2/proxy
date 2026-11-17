# Ultraviolet Web Proxy

A modern Node.js + Express web proxy powered by **Ultraviolet v3**, **bare-mux**, **Epoxy TLS**, and **Wisp** (`@mercuryworkshop/wisp-js`).

## Stack

- **Proxy Rewriter**: `@titaniumnetwork-dev/ultraviolet` (Service Worker interception + HTML/CSS/JS/DOM rewriting)
- **Transport Mux**: `@mercuryworkshop/bare-mux` (`SharedWorker` transport management)
- **Encrypted Client Transport**: `@mercuryworkshop/libcurl-transport` (`libcurl.js` compiled to WebAssembly, full HTTP/2 support)
- **Server Protocol**: `@mercuryworkshop/wisp-js` (multiplexed TCP/UDP proxy over WebSockets at `/wisp/`)
- **HTTP Server**: `express` (`src/server.js`)

## Quick Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in Chrome, Edge, or another desktop Chromium/Firefox browser.

> Note: Service Workers require `http://localhost` (or `https://` when deployed). Port `3000` is used by default to avoid conflicts with tools like Steam's local CEF debugger on port `8080`.

## Configuration

Environment variables supported by `src/server.js`:

- `PORT` — HTTP server port (default: `3000`)
- `HOST` — Bind address (default: `127.0.0.1`; set `0.0.0.0` for LAN/Docker)
- `WISP_ALLOW_PRIVATE_IPS` — Set `"true"` to allow Wisp connections to private LAN IPs (default: `"false"`)
- `WISP_ALLOW_LOOPBACK_IPS` — Set `"true"` to allow Wisp connections to loopback IPs (default: `"false"`)
- `WISP_ALLOW_DIRECT_IP` — Set `"false"` to block raw IP destinations (default: `"true"`)

### Email OTP Account Delivery (Optional)

By default (with no email credentials set), verification codes run in **local dev preview mode** (logged to the server console and shown in the sign-in modal). To send real emails to users' inboxes, set either:

- **Resend**:
  - `RESEND_API_KEY` — Your Resend API key
  - `EMAIL_FROM` — Sender address (e.g. `Simple <noreply@yourdomain.com>`)
- **SMTP (`nodemailer`)**:
  - `SMTP_HOST`, `SMTP_PORT` (default `587`), `SMTP_SECURE` (`true` for port `465`)
  - `SMTP_USER`, `SMTP_PASS`
  - `EMAIL_FROM` or `SMTP_FROM`

## Scripts

- `npm start` — Run the proxy server
- `npm run dev` — Run with Node file watching
- `npm test` — Run HTTP & Wisp WebSocket integration tests
