# Colonist Stats Helper

Small WXT + React Chrome/Chromium extension for capturing Colonist in-game log entries and turning them into a live resource ledger.

## Download

Download the latest packaged extension ZIP after the first release is published:

```text
https://github.com/OsmanYusufTosun/colonist_extension/releases/latest/download/colonist-stats-helper-chrome.zip
```

Chrome does not allow true one-click installation for extensions outside the Chrome Web Store. After downloading:

1. Right-click the ZIP and choose `Extract All`.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Choose `Load unpacked`.
5. Select the extracted extension folder.
6. Open or refresh a game on `https://colonist.io`.

## What it reads

The extension has two capture paths:

- DOM scan: finds the top-right game log panel and reads visible log lines such as `Tessy placed a Settlement`.
- WebSocket hook: a WXT unlisted script is injected into the page's main world before the page game code runs and watches incoming/outgoing WebSocket frames. If Colonist sends readable text or JSON log messages, the extension parses those too.

Captured events are saved in `chrome.storage.local` and shown in a small draggable React overlay. The overlay tracks each player's lumber, brick, wool, grain, and ore from production, trades, bank trades, builds, buys, discards, starting resources, and robberies.

When Colonist hides a robbed resource, the helper keeps every possible resource for that steal. Later spending can resolve the steal automatically; for example, if a player could have stolen lumber or grain but then builds a settlement without any other grain, the helper resolves that steal as grain.

When a player uses Monopoly, the overlay shows a small correction form. Choose the monopolized resource and enter how many total resource cards each other player has left; the helper compares that to its held totals and transfers the difference.

## Develop

```sh
npm install
npm run dev
```

WXT writes the development extension to `output/chrome-mv3`.

## Build

```sh
npm run build
```

To create the same installable ZIP that users download from GitHub Releases:

```sh
npm run zip
```

The ZIP is written to `output/colonist-stats-helper-0.1.3-chrome.zip`.

## Publish a Download

Push a version tag to GitHub:

```sh
git tag v0.1.3
git push origin v0.1.3
```

GitHub Actions will build the extension and attach `colonist-stats-helper-chrome.zip` to the release. Users can download that file from the latest release link above.

## Load it locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked`.
4. Select `output/chrome-mv3`.
5. Open or refresh a game on `https://colonist.io`.

## Quick test

When the game log changes, the overlay event count should increase and the resource table should update. Use:

- `History` to scroll-scan the existing game log and import older rows.
- `Pause` to stop recording temporarily.
- `Sample` to download the raw DOM log sample, visual image metadata, and recent readable WebSocket snippets for parser development.
- `Export` to download the captured event JSON.
- `Clear` to remove local captured events.

## Sharing a parser sample

1. Join a Colonist game and let the top-right log fill with a few turns of events.
2. Click `Sample` in the helper overlay.
3. Send the downloaded `colonist-log-sample.json`.

The sample includes the raw text from the detected DOM log panel, normalized lines, likely event lines, visual lines with detected image tokens, image element metadata, recent readable WebSocket snippets, and the latest parsed event records.

## Scroll behavior

Live DOM capture only records while the game log is at the bottom. If you scroll up to inspect old messages, the helper pauses DOM log importing so the same virtualized rows are not counted again. Use `History` when you want to import the existing scrollback after joining or enabling the extension mid-game.

If `DOM` stays `searching` but `WS` shows frames, Colonist may be rendering the log in canvas or sending a binary protocol. In that case the next step is to inspect the exported/readable WebSocket payload shape and add a protocol-specific parser.
