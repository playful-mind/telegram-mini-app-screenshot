# telegram-mini-app-screenshot

Headless, phone-format screenshots of **any** Telegram Mini App. The CLI signs a valid `initData` with your bot token, attaches it as the `#tgWebAppData` fragment (the official `telegram-web-app.js` picks it up from there), renders the app in headless Chrome as a phone, and saves a PNG.

Works on canvas/WebGL Mini App games and any app that loads `telegram-web-app.js`. No Telegram client, no X server, no manual `tgWebAppData` pasting.

## Install

```bash
git clone https://github.com/playful-mind/telegram-mini-app-screenshot
cd telegram-mini-app-screenshot
npm install        # installs puppeteer-core
chmod +x index.mjs # optional: run it as ./index.mjs
```

You need **Node.js 22.12+** and **Google Chrome or Chromium** installed. The tool drives your system Chrome by default (`/usr/bin/google-chrome-stable`); point it elsewhere with `--chrome <path>` or the `CHROME_PATH` env var.

## Usage

```bash
# Sign initData with your bot token, then shoot the app
BOT_TOKEN=123456:ABC-DEF... \
  ./index.mjs --url https://my-mini-app.example.com --out shot.png

# Same, token from a flag instead of env
./index.mjs --url https://my-mini-app.example.com \
  --token 123456:ABC-DEF... --out shot.png

# Apps that don't read initData (or any plain mobile page)
./index.mjs --url https://my-mini-app.example.com --no-initdata --out shot.png
```

> **Tip:** prefer the `BOT_TOKEN` env var over `--token` — a flag can leak into your shell history and the process list.
>
> When signing, the tool replaces any existing `#fragment` in `--url` with the `tgWebAppData` fragment, so apps that rely on hash-based routing may be affected. Use `--no-initdata` to leave the URL untouched.

### Options

| Flag | Env | Default | Description |
| --- | --- | --- | --- |
| `--url` | — | *(required)* | Mini App URL to screenshot |
| `--out` | — | `screenshot.png` | Output PNG path |
| `--token` | `BOT_TOKEN` | — | Bot token used to sign initData |
| `--user-id` | — | `100000001` | Synthetic Telegram user id in the signed initData |
| `--name` | — | `Tester` | `first_name` in the signed initData |
| `--lang` | — | `en` | `language_code` in the signed initData |
| `--width` | — | `390` | Viewport width (px) |
| `--height` | — | `844` | Viewport height (px) |
| `--dpr` | — | `3` | `devicePixelRatio` |
| `--wait` | — | `5000` | Settle delay before the shot (ms) |
| `--timeout` | — | `30000` | Navigation timeout for page load (ms) |
| `--chrome` | `CHROME_PATH` | `/usr/bin/google-chrome-stable` | Chrome/Chromium executable |
| `--user-agent` | — | iPhone Safari | Override the user agent |
| `--no-initdata` | — | off | Skip initData signing (for apps that don't need it) |
| `--full-page` | — | off | Capture the full scroll height, not just the viewport |
| `--no-sandbox` | — | off | Disable the Chrome sandbox (CI / containers / root) |
| `--help` / `--version` | | | Show help / version |

## How initData signing works

A signed `initData` is how Telegram tells a Mini App *who the current user is*. Normally only the real Telegram client can produce one. This tool forges a valid one so you can load your own app in a plain headless browser.

It follows [Telegram's Web App data validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) in reverse:

1. Build `data_check_string` — the `auth_date` and `user` fields, sorted alphabetically, joined as `key=value` lines.
2. `secret = HMAC-SHA256("WebAppData", BOT_TOKEN)` — the constant string `WebAppData` is the HMAC *key*; the bot token is the message.
3. `hash = HMAC-SHA256(secret, data_check_string)` as hex.
4. Append `hash`, URL-encode the result, and attach it as `#tgWebAppData=<encoded>`. `telegram-web-app.js` parses the fragment and exposes the fields as `window.Telegram.WebApp.initData`.

Because the signature is derived from your bot token, this only authenticates the user to **your own** Mini App — exactly what you need to load and screenshot it headlessly.

## Why this exists

Two recurring pains when you build Telegram Mini Apps:

- **Automated screenshots come back blank.** Most Mini App games render to `<canvas>` / WebGL. Conventional screenshot tools and accessibility snapshots see nothing — there's no DOM to capture. The fix is a *real* headless Chrome render at a phone viewport and `devicePixelRatio`, which is exactly what this tool does.
- **You can't open the app outside Telegram.** Apps guard on `initData`, so a plain browser shows a blank "open in Telegram" wall. Signing a fresh `initData` with your bot token lets you load and screenshot your own app on every commit, in CI, without a phone or the Telegram client.

## Ubuntu 24.04 / AppArmor note

On Ubuntu 24.04, the AppArmor `unrestricted_userns` profile blocks the Chromium build that Puppeteer downloads into its cache — it crashes on launch. The **system-installed** Google Chrome carries a matching AppArmor profile and works, so prefer the system Chrome (the default). If you must use a downloaded Chromium, adjust the profile or pass `--no-sandbox` (the latter is fine for throwaway CI, not for untrusted URLs).

## License

MIT — see [LICENSE](LICENSE).

---

Made by the team behind [Playful Mind](https://playfulmind.me).
