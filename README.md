# agent-browser-mcp

Generic MCP browser server: launches a dedicated Chrome window when an agent
first needs it, drives it over CDP (loopback only), closes it after idle or on
`browser_close`. Zero dependencies — runs on bun >= 1.1 or node >= 21.

Design modeled on [avito-mcp](https://github.com/ermizin/avito-mcp) (MIT), made
site-agnostic: no domain allowlist by default, no site-specific extractors.
Safety kept: CDP on 127.0.0.1 only, risky buttons (send/pay/delete/save/logout/
submit, RU + EN) require `confirm=true`, Enter/submit gated, no stealth patches,
no credential handling — logins are done by the human once in the window and
persist in the profile.

## Example session

```
browser_open({ url: "https://news.ycombinator.com" })
browser_read({ mode: "snapshot" })              → lines: "e1 a 'title' ..."
browser_click({ ref: "e3" })                     → opens the article
browser_read({ mode: "text", max_chars: 4000 })
browser_screenshot({})                            → path to saved PNG
browser_close({})                                 → throwaway data wiped
```

With a persistent profile: `browser_open({ url, profile: "shopping" })`, log
in by hand in the opened window once, then every later session with that
profile is already authenticated.

## Tools

`browser_status`, `browser_profiles`, `browser_open`, `browser_back`,
`browser_read` (mode=text | snapshot with stable `eN` refs, `wait_for_text`),
`browser_click` (ref | text, confirm-gated), `browser_hover`, `browser_type`
(native setter, frameworks notice; returns final value), `browser_press`,
`browser_scroll`, `browser_screenshot` (saved under `$AB_HOME/screenshots`),
`browser_close`, `browser_wait`, `browser_eval` (arbitrary page JS via
`Runtime.evaluate`), `browser_tabs` (multi-tab: list/focus/close).

Typical agent loop: `browser_open` → `browser_read mode=snapshot` →
`browser_click ref=eN` → `browser_read mode=text`.

## Profiles

Default is **throwaway**: a fresh temp `user-data-dir` per launch, wiped on
`browser_close` — nothing survives unless you opt in.

- `browser_open({ url, profile: "name" })` — persistent named profile at
  `~/.agent-browser/profiles/<name>/`; cookies/storage/logins survive close and
  reopen. Name charset: `[a-zA-Z0-9_-]`. If another live Chrome holds that
  profile, the call is rejected with `profile "name" is in use by pid N`.
- `browser_close({ discard: true, profile })` — wipe the named profile's data
  (without `discard` it is kept).
- Switching profiles in one server restarts the browser cleanly (throwaway is
  wiped, named is kept).
- Profile semantics for `browser_open` without `profile`:
  - browser **running** → navigates the current browser, keeps its profile
    (implicit addressing: `open(profile:X)` then plain `read`/`click`/`open`
    all address the same browser);
  - browser **closed** → fresh throwaway, never resurrects the last named
    profile;
  - explicit `profile` differing from the running one → clean restart-switch.
- `AB_PROFILE` env still works: when set, it is the persistent default for
calls without `profile` (instead of throwaway).

## Profile inventory

`browser_profiles()` — read-only, never launches a browser. Answers "what
profiles exist and which am I in" without filesystem access:

- `named` — profiles under `~/.agent-browser/profiles/` with `inUse`
  (live `.agent-browser.lock` holder or, on POSIX, a live Chrome
  `SingletonLock`), `lockHolderPid`/`chromePid` when held, rough `sizeBytes`/
  `sizeMB`, and `lastModified`;
- `active` — the running browser's profile (`null` if none);
- `browserRunning` — whether a browser is up;
- `defaultSource` — `"AB_PROFILE env"` (with `defaultDir`) or
  `"throwaway (fresh temp dir per launch)"` — what a `browser_open` without
  `profile` resolves to;
- `lastRequested` — the last profile name a caller asked for.

Every `browser_status`/`browser_open`-style response also carries
`activeProfile: { name, dir, persistent }` identity context while a browser
runs.

## Env

`XAUTHORITY` is resolved at startup by the server itself: a provided value is
kept only if the file still exists, otherwise the newest
`/run/user/$UID/xauth_*` wins (the filename is random per login, so a value
baked into host config goes stale at the next login). Setting it in the host
ev is a best-effort fallback only.

The server also exits when its stdin closes (host restart/replacement), so
node-host restarts no longer leave orphaned MCP servers holding profile locks.

| Var | Default | Meaning |
|---|---|---|
| `AB_HOME` | `~/.agent-browser` | work dir (profiles, screenshots) |
| `AB_CHROME` | autodetect | browser binary |
| `AB_PROFILE` | unset (throwaway) | persistent default profile dir |
| `AB_PORT` | `9777` | CDP port (loopback only) |
| `AB_IDLE_SECONDS` | `900` | auto-close after N s idle (0 = off) |
| `AB_HEADLESS` | `0` | `1` = headless; auto-falls-back to headless if no DISPLAY/WAYLAND_DISPLAY |
| `AB_EXTRA_ARGS` | — | extra Chrome flags |

## Wire as node-hosted MCP for openclaw

On the **node machine**, in its `openclaw.json`:

```json5
{
  nodeHost: {
    mcp: {
      servers: {
        "agent-browser": {
          command: "/usr/local/bin/bun",       // or node >= 21
          args: ["/opt/agent-browser-mcp/server.mjs"],
        },
      },
    },
  },
}
```

Then `openclaw node restart` on that machine. The node publishes the tools;
the gateway needs no config. On a headless server set `AB_HEADLESS=1` (or run
under Xvfb for a visible session via VNC), and keep `AB_IDLE_SECONDS` set so
the browser does not sit idle. To pin the agent to specific sites, add the
gateway-side exec deny/allow or simply instruct the agent.

## Standalone / other clients

Any MCP client that speaks stdio:

```json
{ "mcpServers": { "agent-browser": { "command": "bun",
  "args": ["/path/to/agent-browser-mcp/server.mjs"] } } }
```

## Stealth / bot-check posture

Launch flags include `--disable-blink-features=AutomationControlled` (so
`navigator.webdriver` is false), a normal 1920x1080 window size, and per-tab
overrides pin the timezone (`AB_TZ`, default Europe/Moscow), strip any
`Headless` UA marker and set ru-RU languages, and a tiny
`chrome.runtime` shim is injected before page scripts (clean profiles have
no extensions, so `window.chrome.runtime` is otherwise undefined — commodity
checks flag that). `browser_eval` exposes
`Runtime.evaluate` for checks. Honest limits: this raises the bar against
commodity bot checks (bot.sannysoft.com passes), but a CDP-driven Chrome is
detectable in principle; no flag set guarantees passage against Cloudflare
Turnstile, PerimeterX or similar — headless adds further fingerprint surface
(e.g. WebGL/GPU strings). For hard targets, use a headful window with a
persistent named profile and do the login yourself.

Known residual tell: in **headless** mode WebGL reports SwiftShader
(`ANGLE (Google, Vulkan ..., SwiftShader)`), not the real GPU. Trying to force
the real GPU (`AB_EXTRA_ARGS=--use-angle=vulkan,--enable-unsafe-gpu,--enable-gpu`)
makes WebGL return `null` entirely — worse. Treat headless WebGL as unfixable
at this layer; use headful for GPU-sensitive checks.

## Process hygiene (zombies)

When the server runs under openclaw's node host, the host's
`service-child-group-anchor` is a subreaper that never reaps: any Chrome
descendant that outlives its parent would orphan to it and stay a zombie.
Defense is layered:

1. On bun, the server makes **itself** a subreaper (`PR_SET_CHILD_SUBREAPER`
   via `bun:ffi`) and runs a 1 s `waitpid(-1, WNOHANG)` loop — orphaned Chrome
   descendants reparent to the server and are reaped immediately. (Plain-node
   hosts skip this; they get layer 2 only.)
2. Shutdown is staged: SIGTERM to the Chrome main process alone first (it
   terminates and reaps its own tree); only on timeout do we kill descendants
   deepest-first and then the leader.

## Headful window geometry

Headful windows are fitted to the real logical work area at launch — including
fractional-scale Wayland desktops — via CDP, not xrandr: the window is briefly
maximized (`Browser.setWindowBounds`), its bounds read back (maximized bounds
= the compositor's work area in logical pixels, panels/dock excluded by
construction), then a normal window is placed inside it at (10, 10) with small
margins. Nothing display-related is hardcoded — scale, work area and window
size are all derived at launch time, so docking, external monitors and other
machines (incl. Windows) are picked up automatically. Headful runs on the
session's native backend (Wayland included); on Wayland the compositor owns
placement — the work-area-derived SIZE is what keeps the window on screen.
`--test-type` hides the unsupported-flag infobar and `--hide-crash-restore-bubble`
kills the "Restore pages?" bubble after kill-based profile switches. Headless
geometry (1920x1080 ozone screen) is a fingerprint choice and stays fixed.

## Windows support

Windows 11 is supported on a best-effort basis:

- `chrome.exe` is resolved from `AB_CHROME`, the `PATH`, `Program Files`,
  `Program Files (x86)`, and `LocalAppData` (Edge fallback: `msedge.exe`).
- Process teardown uses `taskkill /PID <pid> /T /F`, which walks the whole
  Chrome tree; the POSIX process-group SIGTERM/SIGKILL staging does not apply.
- The `SingletonLock` check is skipped on Windows; profile locks
  (`.agent-browser.lock`) are cross-platform.
- No `DISPLAY`/`WAYLAND_DISPLAY` needed; headful Chrome opens on the desktop.

The Windows path has **not been tested on a real Windows machine**. On first
run verify: `browser_open` shows a window, `browser_close` leaves no
`chrome.exe` behind (`tasklist | findstr chrome`), and named profiles persist
under `%USERPROFILE%\.agent-browser\profiles\`.

## Test

```
bun smoke.mjs   # profiles, concurrency, headless override, stealth checks
```

## Tabs (multi-tab support)

### Tab selection semantics

- The canonical selector param is `tabIndex` (there is no `index` param — unknown `browser_tabs` params are rejected loudly instead of being silently ignored).
- `tabIndex` is **stable**: index N refers to the Nth tab of the most recent tab list the caller saw (from `browser_tabs(action:"list")` or any response carrying `tabs`). If tabs have spawned or closed since, you get a clear stale-index error instead of silently acting on the wrong tab — re-list and retry.
- `targetId` is always unambiguous and preferred when you already have it.
- Closing the active tab waits until Chrome actually reports it gone before switching (`switchedTo` never names a closed tab).

Websites routinely open new tabs (`target=_blank` product/order links, OAuth flows). The driver follows them:

- `browser_open` gains `newTab: true` (open in a new tab + switch) and `tabIndex: N` (navigate an existing tab).
- `browser_tabs` tool: `action=list` (index/targetId/url/title + activeTargetId), `action=focus`, `action=close` (closing the active tab switches to the first remaining).
- `browser_click` on a `target=_blank` link auto-follows the new tab (result carries `newTab: true` + `tabCount`).
- **tabs_changed piggyback**: every `browser_*` response carries a `tabs_changed: {count, added:[{url,title}], removed:[ids]}` field whenever the tab set changed since the last call — the agent learns about spawned/closed tabs on its very next action, no polling needed.
- Chrome is launched with `--disable-popup-blocking`: synthetic `el.click()`/`window.open()` carry no user activation, so without it Chrome silently swallows `_blank` opens (verified: `window.open` returned BLOCKED without the flag).

## License

MIT — see [LICENSE](LICENSE).
