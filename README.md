# ClassicMail

An Outlook Classic-style mail and calendar client for Ubuntu. It talks directly to your mail servers over IMAP/SMTP (no cloud service in between), so all your Gmail and other accounts sit in one window with a unified inbox.

Built with Electron 44 and React 19. Not affiliated with Microsoft; it uses no Microsoft code, names or artwork, it only follows the familiar layout (ribbon, folder pane, message list, reading pane).

## What it does

**Mail**
- Any number of accounts: Gmail, Yahoo, iCloud, Fastmail or any other IMAP/SMTP server.
- Favorites (All Inboxes, Unread Mail) plus one folder tree per account, with unread counts. All Inboxes shows each account's newest 200 messages; open an account's own Inbox to go further back.
- Message list with search, All/Unread filter, date groups, right/bottom/off reading pane, list or table layout.
- Reply, Reply All, Forward (attachments come along), New Email in its own window, drafts, signatures, address suggestions from people you have written to.
- Delete (to Deleted Items), Archive, Junk, flag, mark read/unread, drag and drop between folders of the same account, create/rename/delete folders.
- Unsubscribe button for mailing lists that advertise an unsubscribe link or address in their headers.
- Desktop notifications for new mail, and an unread badge on the launcher where the desktop supports one; checks every 30 s to 60 min (setting) and on F9.
- Can be your default mail app: `mailto:` links open a pre-filled message.
- Light and dark theme.

**Calendar (read-only)**
- Add calendars by ICS link (https:// or webcal://) or by .ics file.
- Day, Work Week, Week and Month views, recurring events, all-day events, time zones, "Join meeting" button when an event contains a Teams, Zoom, Google Meet or Webex link.
- Links are re-fetched every 15 minutes; the last good copy is shown if a link is temporarily unreachable.

**Known limits:** replies go to the Reply-To address when a message has one, and the recipient chip shows the sender's name (hover for the address); autocomplete suggestions include people who merely wrote to you.

**Not included (yet):** creating or editing events, accepting invitations, rules, categories, conversation view, offline cache, PGP/S-MIME, OAuth sign-in (Gmail uses an app password), Exchange/EWS.

## Install

### From the .deb (recommended)

```bash
sudo apt install ./classicmail_0.2.2_amd64.deb
classicmail          # or find "ClassicMail" in your app launcher
```

### From the AppImage

```bash
chmod +x ClassicMail-0.2.2.AppImage
./ClassicMail-0.2.2.AppImage
```
On Ubuntu 24.04 the AppImage may need `--no-sandbox` because AppArmor blocks unprivileged user namespaces for unpackaged apps. The .deb installs an AppArmor profile and does not have this problem.

### Passwords need a system keyring

ClassicMail stores passwords encrypted with your desktop keyring and refuses to save them anywhere else. Ubuntu Desktop has one out of the box. On a minimal install:

```bash
sudo apt install gnome-keyring libsecret-1-0
```
then log out and back in. Settings → General shows the keyring status.

### Build it yourself

Needs Node 20 or newer.

```bash
./scripts/build-ubuntu.sh            # installs dependencies, builds release/*.deb and release/*.AppImage
./scripts/build-ubuntu.sh --test     # same, after running the tests
```
or by hand: `npm install && npm run dist`. The first build downloads the `fpm` packaging tool.

To run from source without packaging: `npm install && npm start`. If Electron complains about `chrome-sandbox`, either run
`sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
or start with `npx electron . --no-sandbox`. For live reload while developing: `npm run dev`.

Before publishing the package, edit `homepage` and `build.linux.maintainer` in `package.json`.

## Set up your accounts

### Gmail (repeat for each account)
1. Turn on 2-Step Verification for the Google account (an app password cannot be created without it).
2. Open <https://myaccount.google.com/apppasswords>, create an app password named "ClassicMail" and copy the 16 letters.
3. In ClassicMail: File → Add account, type the Gmail address (the account type and servers are filled in), paste the app password, Save.
   ClassicMail tests IMAP and SMTP before saving and tells you which one failed.

If Google does not offer app passwords for an account (some Workspace domains disable them), ask the administrator to allow them; ClassicMail does not use OAuth.

### Other IMAP accounts
Choose the provider, or "Other IMAP account" and enter the IMAP and SMTP server, port and security (SSL/TLS or STARTTLS). "None" (no encryption) is only accepted for `localhost`, which is what the tests use.

### Calendars
- **Google Calendar:** calendar settings → Integrate calendar → *Secret address in iCal format*. Anyone with that link can read the calendar, so treat it like a password.
- **Outlook.com / Microsoft 365:** Settings → Calendar → Shared calendars → Publish a calendar → ICS link.
- **Any .ics file:** Settings → Calendars → Add → .ics file.

### Make it the default mail app
```bash
xdg-settings set default-url-scheme-handler mailto classicmail.desktop
```

## Keyboard shortcuts

| | |
|---|---|
| Ctrl+N | New email |
| Ctrl+R / Ctrl+Shift+R / Ctrl+F | Reply / Reply All / Forward |
| Delete | Delete (in Deleted Items: delete permanently, after a confirmation) |
| Ctrl+Q / Ctrl+U | Mark read / unread |
| Insert | Flag / unflag |
| Ctrl+A | Select all in the list |
| Ctrl+E | Search |
| F9 | Send/Receive now |
| Ctrl+1 / Ctrl+2 | Mail / Calendar |
| Ctrl+Enter, Ctrl+S | (compose window) Send, save draft |
| Ctrl+Shift+Q | Quit |

## Security and privacy

- **Message content is untrusted.** Each message is rendered in a sandboxed iframe with scripts disabled and an opaque origin, behind its own Content-Security-Policy, after DOMPurify has removed forms, frames, SVG, `<link>`, `<meta>` and everything else that can run or phone home. Remote images, CSS `url()` and `@import` are removed until you press "Download pictures" for that message (or turn the setting on).
- **The UI has no Node access.** The window runs with `contextIsolation` and the Chromium sandbox; the only thing it can do is call a fixed list of named requests through a preload bridge. The main process only answers the app's own top-level page, and links clicked in mail open in your default browser (http, https and `mailto:` only).
- **Passwords** are encrypted with the system keyring (Electron `safeStorage` → libsecret). If no real keyring is available the app refuses to store them. They are never written to logs or sent anywhere except to the mail server you configured.
- **Delete never destroys by accident.** Delete moves to the server's Trash/Deleted Items; only Delete inside Deleted Items removes permanently, after a confirmation. Actions that the server refuses are reported as errors instead of being shown as done, and on servers without the IMAP MOVE command the original is only removed after the server has confirmed the copy.
- **A broken calendar cannot hang the app.** Calendars are read in a background thread with a time limit; an event whose recurrence rule never finishes is left out (with a notice) and the rest of the calendar is shown.
- **Sending:** if the server refuses only some recipients, the message counts as sent (it was delivered to the others) and you are told which addresses were refused, so it is not sent twice by mistake.
- **Network traffic:** only to your IMAP/SMTP servers, your calendar links, and pictures you chose to download. Chromium's background services (component updates, sync, pings) are switched off. The one exception: Chromium's spell checker fetches its dictionary file from Google's CDN the first time you compose (no mail text is sent). Start with `CLASSICMAIL_NO_SPELLCHECK=1` to disable spell checking.
- **AI drafting (optional, off by default):** Settings → AI lets you enable a "Draft with Claude" button in the compose window, using your own Anthropic API key. When you use it, the message you're replying to (or forwarding) and your instructions are sent to Anthropic's API — the one deliberate exception to "no cloud service in between," and only when you've explicitly turned it on. The key is encrypted at rest the same way account passwords are. Claude only ever fills the compose editor with draft text for you to review and edit; it never sends mail on its own.
- Data lives in `~/.config/ClassicMail/` (account settings with encrypted passwords, calendar list, settings, address suggestions). Removing an account in Settings deletes its saved password.

## Tests

```bash
pip install pymap                    # in-memory IMAP server used by the tests
npm test                             # 60 unit/integration tests: store, mail engine, calendar, date helpers, regressions
npm run test:e2e                     # browser test of the whole UI on built-in demo data (needs Playwright + Chromium)
xvfb-run -a npm run test:electron    # runs the real Electron app against a local IMAP server and SMTP sink
                                     #   (needs `npm run build:ui` first, plus Playwright)
```
`npm run dev` and the e2e test use a built-in demo mailbox with three fictional accounts; production builds contain no demo data.

### What the tests do and do not cover
Covered: everything above against a local IMAP server (pymap) and a local SMTP server; the real Electron app end to end, from source and from the installed .deb (add account, bad password, read, delete, send, calendar including a hostile recurrence rule, mailto:, restart); the reading-pane and compose-window sanitizers with hostile HTML in a real browser. The path for servers without the IMAP MOVE command is tested against a real server with MOVE switched off on the client side.

**Not covered because it needs your real accounts:** signing in to Gmail with an app password, Gmail's own search (`X-GM-RAW`, with an automatic fallback to standard IMAP search if the server rejects it), Gmail-specific folder behaviour, Yahoo/iCloud/Fastmail servers, and a real desktop keyring. The first time you add a Gmail account is therefore the first real test; if something misbehaves, Settings → Accounts → Test connection shows the exact IMAP/SMTP error.

## Project layout

```
electron/main.js            windows, IPC handlers, polling, notifications, single-instance, mailto:
electron/preload.js         the whitelisted bridge exposed to the UI
electron/services/store.js  accounts, calendars, settings, contacts, encrypted passwords
electron/services/mail.js   IMAP/SMTP engine (imapflow, nodemailer, mailparser)
electron/services/calendar.js  ICS fetch, cache and recurrence expansion (ical.js)
src/                        React UI (App, components, lib, demo backend in lib/mockApi.js)
test/                       unit/integration tests, e2e tests, fixtures
build/                      app icon (icon.svg, icon.png)
scripts/                    build-ubuntu.sh, make-icon.js
```

MIT licensed.
