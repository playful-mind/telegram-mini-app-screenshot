#!/usr/bin/env node
/**
 * telegram-mini-app-screenshot
 *
 * Headless, phone-format screenshots of any Telegram Mini App.
 *
 * Signs a valid initData with your bot token, attaches it as the
 * #tgWebAppData fragment (the official telegram-web-app.js picks it up from
 * there), renders the app in headless Chrome emulating a phone viewport, and
 * saves a PNG.
 *
 * Works on canvas/WebGL Mini App games and any app that loads
 * telegram-web-app.js. No Telegram client, no X server, no manual
 * tgWebAppData pasting required.
 *
 * MIT licensed. See README.md and LICENSE.
 */
import { createHmac } from "node:crypto";
import { access, constants, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const VERSION = "1.0.0";

// System Chrome is the default: on Ubuntu 24.04 its AppArmor profile survives
// the userns restriction that crashes the Chromium build Puppeteer downloads.
const CHROME_DEFAULT = "/usr/bin/google-chrome-stable";
const CHROME_FALLBACKS = [
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/chrome",
	"/snap/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

// A phone user agent so responsive apps render the mobile layout rather than
// the desktop one under headless Chrome.
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Dedicated profile dir: never locks horns with a desktop Chrome session.
const PROFILE_DIR = join(tmpdir(), "telegram-mini-app-screenshot-profile");

function fail(message, code = 1) {
	console.error(`error: ${message}`);
	process.exit(code);
}

function printHelp() {
	console.log(`telegram-mini-app-screenshot ${VERSION}
Headless phone-format screenshots of any Telegram Mini App.

USAGE
  telegram-mini-app-screenshot --url <miniapp-url> [options]

OPTIONS
      --url <url>        Mini App URL to screenshot (required)
      --out <file.png>   Output PNG path (default: screenshot.png)
      --token <token>    Bot token used to sign initData (env: BOT_TOKEN)
      --user-id <n>      Synthetic Telegram user id (default: 100000001)
      --name <s>         first_name in the signed initData (default: Tester)
      --lang <code>      language_code in the signed initData (default: en)
      --width <px>       Viewport width (default: 390)
      --height <px>      Viewport height (default: 844)
      --dpr <n>          devicePixelRatio (default: 3)
      --wait <ms>        Settle delay before the shot (default: 5000)
      --chrome <path>    Chrome/Chromium executable (env: CHROME_PATH,
                         default: /usr/bin/google-chrome-stable)
      --user-agent <ua>  Override user agent (default: iPhone Safari)
      --no-initdata      Skip initData signing (for apps that don't need it)
      --full-page        Capture the full scroll height, not just the viewport
      --no-sandbox       Disable Chrome sandbox (CI / containers / root)
      --help             Show this help
      --version          Show version

EXAMPLES
  BOT_TOKEN=123:ABC telegram-mini-app-screenshot --url https://app.example.com --out shot.png
  telegram-mini-app-screenshot --url https://app.example.com --no-initdata --out shot.png

HOW IT WORKS
  initData is signed with HMAC-SHA256 (secret = HMAC("WebAppData", BOT_TOKEN),
  hash = HMAC-SHA256(secret, data_check_string)), then attached as
  #tgWebAppData=<encoded>. telegram-web-app.js exposes it as
  window.Telegram.WebApp.initData, so you can load and screenshot your own
  app headlessly, without a phone or the Telegram client.
`);
}

// --- parse args ---
const { values } = parseArgs({
	options: {
		url: { type: "string" },
		out: { type: "string" },
		token: { type: "string" },
		"user-id": { type: "string" },
		name: { type: "string" },
		lang: { type: "string" },
		width: { type: "string" },
		height: { type: "string" },
		dpr: { type: "string" },
		wait: { type: "string" },
		chrome: { type: "string" },
		"user-agent": { type: "string" },
		"no-initdata": { type: "boolean", default: false },
		"full-page": { type: "boolean", default: false },
		"no-sandbox": { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		version: { type: "boolean", default: false },
	},
	strict: true,
	allowPositionals: false,
});

if (values.help) {
	printHelp();
	process.exit(0);
}
if (values.version) {
	console.log(VERSION);
	process.exit(0);
}

const url = values.url;
if (!url) fail("--url <miniapp-url> is required. Run --help for usage.");

const out = values.out ?? "screenshot.png";
const width = Number(values.width ?? 390);
const height = Number(values.height ?? 844);
const dpr = Number(values.dpr ?? 3);
const waitMs = Number(values.wait ?? 5000);
const fullPage = values["full-page"];
const noSandbox = values["no-sandbox"];
const wantInitData = !values["no-initdata"];
const userAgent = values["user-agent"] ?? DEFAULT_USER_AGENT;

if (
	![width, height, dpr, waitMs].every((n) => Number.isFinite(n)) ||
	width <= 0 ||
	height <= 0 ||
	dpr <= 0 ||
	waitMs < 0
) {
	fail("--width, --height, --dpr must be positive numbers; --wait must be >= 0.");
}

const token = values.token ?? process.env.BOT_TOKEN;
if (wantInitData && !token) {
	fail(
		"initData signing needs a bot token: pass --token <token> or set BOT_TOKEN (or use --no-initdata to skip signing).",
	);
}

const userId = Number(values["user-id"] ?? 100000001);
if (!Number.isFinite(userId)) fail("--user-id must be a number.");
const name = values.name ?? "Tester";
const lang = values.lang ?? "en";

/**
 * Sign an initData querystring per Telegram's Web App data validation, and
 * wrap it as the tgWebAppData fragment value.
 *
 *   secret          = HMAC-SHA256(key="WebAppData", message=BOT_TOKEN)   (raw bytes)
 *   hash            = HMAC-SHA256(key=secret, message=data_check_string) (hex)
 *   data_check_string = "<key>=<value>" lines, keys sorted alphabetically
 *
 * The returned string is `tgWebAppData=<encoded>`, ready to drop into a URL
 * hash. telegram-web-app.js parses the hash, validates the hash, and exposes
 * the fields as window.Telegram.WebApp.initData.
 */
function buildInitDataFragment({ token, userId, name, lang }) {
	const user = { id: userId, first_name: name };
	if (lang) user.language_code = lang;
	const params = {
		auth_date: String(Math.floor(Date.now() / 1000)),
		user: JSON.stringify(user),
	};
	const dataCheckString = Object.keys(params)
		.sort()
		.map((k) => `${k}=${params[k]}`)
		.join("\n");
	const secret = createHmac("sha256", "WebAppData").update(token).digest();
	const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
	const queryString = new URLSearchParams({ ...params, hash }).toString();
	return `tgWebAppData=${encodeURIComponent(queryString)}`;
}

// Build the final URL, optionally with the signed fragment.
let finalUrl;
try {
	const parsed = new URL(url);
	if (wantInitData) {
		parsed.hash = buildInitDataFragment({ token, userId, name, lang });
	}
	finalUrl = parsed.toString();
} catch {
	fail(`Could not parse --url "${url}" as a URL. Include the scheme, e.g. https://...`);
}

async function resolveChrome() {
	const tried = [];
	const candidates = [
		values.chrome,
		process.env.CHROME_PATH,
		CHROME_DEFAULT,
		...CHROME_FALLBACKS,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		tried.push(candidate);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	fail(
		`Chrome/Chromium executable not found.\n` +
			`Install Google Chrome, pass --chrome <path>, or set CHROME_PATH.\n` +
			`Tried:\n  ${tried.join("\n  ")}`,
	);
}

async function main() {
	const chromePath = await resolveChrome();

	let puppeteer;
	try {
		puppeteer = (await import("puppeteer-core")).default;
	} catch {
		fail("puppeteer-core is not installed. Run `npm install` first.");
	}
	if (!puppeteer || typeof puppeteer.launch !== "function") {
		fail("puppeteer-core did not export a launch() function. Try reinstalling.");
	}

	// Make sure the output directory exists (e.g. --out shots/app.png).
	await mkdir(dirname(out), { recursive: true }).catch(() => {});

	const launchArgs = [
		`--user-data-dir=${PROFILE_DIR}`,
		`--window-size=${width},${height}`,
	];
	if (noSandbox) launchArgs.push("--no-sandbox");

	let browser;
	try {
		browser = await puppeteer.launch({
			executablePath: chromePath,
			headless: true,
			args: launchArgs,
		});
	} catch (err) {
		fail(
			`Could not launch Chrome at ${chromePath}: ${err?.message ?? err}\n` +
				"(On Ubuntu 24.04, prefer the system Chrome; in CI/containers try --no-sandbox.)",
		);
	}

	try {
		const page = await browser.newPage();
		await page.setUserAgent(userAgent);
		await page.setViewport({
			width,
			height,
			deviceScaleFactor: dpr,
			isMobile: true,
			hasTouch: true,
		});
		await page.goto(finalUrl, { waitUntil: "load", timeout: 30_000 });
		// Give scenes/tweens/network a moment to settle before the shot.
		await new Promise((r) => setTimeout(r, waitMs));
		await page.screenshot({ path: out, fullPage });
		const note = wantInitData ? " (initData signed)" : " (no initData)";
		console.log(`saved ${out} (${width}x${height} @ dpr=${dpr})${note}`);
	} catch (err) {
		await browser.close().catch(() => {});
		fail(`Screenshot failed: ${err?.message ?? err}`);
	}
	await browser.close().catch(() => {});
}

main();
