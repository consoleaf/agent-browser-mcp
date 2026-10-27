#!/usr/bin/env bun
// agent-browser — generic node-hosted MCP browser server.
// Launches a dedicated Chrome/Chromium window on first use, drives it over CDP
// (loopback only), closes it on idle or browser_close. Zero npm dependencies:
// needs only bun >= 1.1 or node >= 21 (global WebSocket, fetch).
//
// Modeled on avito-mcp (ermizin/avito-mcp, MIT) but site-agnostic.
//
// Env:
//   AB_HOME          work dir          (default ~/.agent-browser)
//   AB_CHROME        browser binary    (default: first found of
//                                      google-chrome-stable, google-chrome,
//                                      chromium, chromium-browser,
//                                      brave-browser, msedge)
//   AB_PROFILE       profile dir       (default $AB_HOME/chrome-profile)
//   AB_PORT          CDP port          (default 9777, loopback only)
//   AB_IDLE_SECONDS  auto-close after N s without tool calls (default 900, 0=off)
//   AB_HEADLESS      1 = headless      (default 0)
//   AB_EXTRA_ARGS    extra Chrome flags, space-separated
//
// Tools: browser_status, browser_open, browser_back, browser_read,
//        browser_click, browser_hover, browser_type, browser_press,
//        browser_scroll, browser_screenshot, browser_close, browser_wait

import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.AB_HOME || path.join(os.homedir(), ".agent-browser");
const PROFILE = process.env.AB_PROFILE || null; // persistent default ONLY if explicitly set via env; otherwise throwaway per launch
const PORT = Number(process.env.AB_PORT || 9777);
const IDLE_S = Number(process.env.AB_IDLE_SECONDS ?? 900);
const HEADLESS = process.env.AB_HEADLESS === "1";

const IS_WIN = process.platform === "win32";

// Chrome under the minimal nodeHost env can't see the desktop session
// (XDG_CURRENT_DESKTOP, portals over dbus, GTK/QT theme vars) → loses dark
// theming. Inherit from the LIVE session — DESKTOP-INDEPENDENT discovery:
// 1. loginctl list-sessions → ShowProperties/leader PID (works on any DE/systemd host)
// 2. fallback: any of OUR uid's processes whose /proc/<pid>/environ has
//    WAYLAND_DISPLAY or DISPLAY set (pick the lowest pid — the session leader)
// 3. last resort: fixed portal/dbus default /run/user/<uid>/bus
// Theming itself goes through org.freedesktop.portal.Settings over the session
// bus — DE-agnostic as long as the bus + XDG_CURRENT_DESKTOP are correct.
// Re-run before EVERY chrome launch: a long-lived server (or one started
// before a session change) must not keep a stale env snapshot.
function readProcEnv(pid) {
  const env = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}
function applySessionEnv(sessEnv) {
  const want = ["XDG_CURRENT_DESKTOP", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS", "XDG_SESSION_TYPE",
    "XDG_SESSION_DESKTOP", "XDG_MENU_PREFIX", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "DISPLAY", "LANG",
    "KDE_FULL_SESSION", "KDE_SESSION_VERSION", "DESKTOP_SESSION"];
  for (const k of want) if (!process.env[k] && sessEnv[k]) process.env[k] = sessEnv[k];
  for (const k of Object.keys(sessEnv)) {
    if (/^(GTK_|QT_|XCURSOR|LC_)/.test(k) && process.env[k] === undefined) process.env[k] = sessEnv[k];
  }
}
async function inheritSessionEnv() {
  if (IS_WIN || !process.env.XDG_RUNTIME_DIR) return;
  try {
    const fsMod = fs;
    if (!process.env.XAUTHORITY || !fsMod.existsSync(process.env.XAUTHORITY)) {
      const cands = fsMod.readdirSync(process.env.XDG_RUNTIME_DIR)
        .filter((f) => f.startsWith("xauth_"))
        .map((f) => {
          const p = `${process.env.XDG_RUNTIME_DIR}/${f}`;
          return { p, m: fsMod.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.m - a.m);
      if (cands.length) process.env.XAUTHORITY = cands[0].p;
    }
    const { spawnSync } = await import("node:child_process");
    // candidate session-leader pids, in preference order
    const candidates = [];
    try {
      // loginctl: any DE on a systemd host. Parse pid= from ShowProperties Leader.
      const ls = spawnSync("loginctl", ["list-sessions", "--no-legend"], { encoding: "utf8" });
      if (ls.status === 0) {
        for (const line of ls.stdout.split("\n")) {
          const sid = line.trim().split(/\s+/)[0];
          if (!sid || !/^\S+$/.test(sid)) continue;
          const props = spawnSync("loginctl", ["show-session", sid, "--property=Leader", "--property=Type"], { encoding: "utf8" });
          if (props.status !== 0) continue;
          const leader = /Leader=(\d+)/.exec(props.stdout)?.[1];
          const type = /Type=(\w+)/.exec(props.stdout)?.[1] || "";
          if (leader && (type === "wayland" || type === "x11" || type === "tty")) candidates.push(leader);
        }
      }
    } catch {}
    // fallback: our uid's processes that carry a display — lowest pid wins
    if (!candidates.length) {
      const uid = process.getuid?.() ?? 1000;
      const pids = fsMod.readdirSync("/proc").filter((s) => /^\d+$/.test(s)).map(Number).sort((a, b) => a - b);
      for (const p of pids) {
        try {
          if (fsMod.statSync(`/proc/${p}`).uid !== uid) continue;
          const env = fsMod.readFileSync(`/proc/${p}/environ`, "utf8");
          if (/(?:^|\0)(?:WAYLAND_DISPLAY|DISPLAY)=/.test(env)) { candidates.push(String(p)); break; }
        } catch {}
      }
    }
    let applied = false;
    for (const shell of candidates) {
      try {
        // leaders can be root-owned (sddm-helper) — unreadable is fine, fall through
        const sessEnv = readProcEnv(shell);
        if (!sessEnv.WAYLAND_DISPLAY && !sessEnv.DISPLAY) continue;
        applySessionEnv(sessEnv);
        applied = true;
        break; // first usable session wins
      } catch {}
    }
    // loginctl leaders often lack WAYLAND_DISPLAY (the compositor sets it for
    // its children). Scan our uid's processes for a display-carrying env —
    // lowest pid wins (the session's oldest live member).
    if (!applied) {
      const uid = process.getuid?.() ?? 1000;
      const pids = fsMod.readdirSync("/proc").filter((s) => /^\d+$/.test(s)).map(Number).sort((a, b) => a - b);
      for (const p of pids) {
        try {
          if (fsMod.statSync(`/proc/${p}`).uid !== uid) continue;
          const sessEnv = readProcEnv(p);
          if (!sessEnv.WAYLAND_DISPLAY && !sessEnv.DISPLAY) continue;
          applySessionEnv(sessEnv);
          applied = true;
          break;
        } catch {}
      }
    }
    // last resort: standard per-user session bus (portals listen here)
    if (!process.env.DBUS_SESSION_BUS_ADDRESS)
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
  } catch {}
}
await inheritSessionEnv();

// List member pids of the process group led by `leaderPid` (chrome is spawned detached → group leader).
// POSIX-only; returns [] on failure.
function groupMembers(leaderPid) {
  if (IS_WIN) return [];
  const out = [];
  try {
    for (const d of fs.readdirSync("/proc").filter((s) => /^\d+$/.test(s))) {
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
        // comm may contain spaces/parens — parse pgid after the closing paren of comm
        const close = st.lastIndexOf(")");
        const f = st.slice(close + 2).split(" "); // f[0]=state, then ppid=f[1], pgrp=f[2]
        if (Number(f[2]) === leaderPid) out.push(Number(d));
      } catch {}
    }
  } catch {}
  return out;
}

const CHROME_CANDIDATES = IS_WIN ? [
  process.env.AB_CHROME,
  ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.env["ProgramFiles(x86)"] ? [path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
] : [
  process.env.AB_CHROME,
  "google-chrome-stable", "google-chrome", "chromium", "chromium-browser",
  "brave-browser", "msedge",
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

// ---------------------------------------------------------------- state
const PROFILES_DIR = path.join(HOME, "profiles");
let curProfile = null;   // { name: string|null, dir, persistent } while a browser runs
let lastRequested = null; // last profile name a caller asked for
let chromeProc = null;
let lastChromePid = null; // process-group leader for cleanup on exit
let ws = null;            // CDP session websocket (page-level)
let wsTargetId = null;
let msgId = 0;
const pending = new Map();
let idleTimer = null;
let refs = new Map();     // "e12" -> css path, from last snapshot
let lastNavAt = 0;

function chromeBinary() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes("/")) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
    else { try { return spawn("which", [c]).stdout && c; } catch {} }
  }
  return null;
}

function findChromeSync() {
  // sync lookup without which-spawn games
  for (const c of CHROME_CANDIDATES) {
    if (c.includes("/") || c.includes("\\")) {
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
    } else {
      for (const dir of (process.env.PATH || "").split(IS_WIN ? ";" : ":")) {
        const p = path.join(dir, c);
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
      }
    }
  }
  return null;
}

// Kill the chrome process tree. POSIX: negative-pid group signal (children receive it directly,
// so they die while the main process lives and reaps them). win32: taskkill /T /F (no signals).
function killTree(pid, signal = "SIGKILL") {
  if (pid == null) return;
  if (IS_WIN) {
    if (signal === "SIGKILL") { try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
    // win32 has no graceful signal; taskkill /T without /F sends WM_CLOSE — ineffective for
    // background chrome children, so we only force-kill there and accept the harder shutdown.
  } else {
    try { process.kill(-pid, signal); } catch {}
    try { process.kill(pid, signal); } catch {}
  }
}

async function httpJson(meth, urlPath) {
  if (!curPort) throw new Error("browser not running");
  const res = await fetch(`http://127.0.0.1:${curPort}${urlPath}`, { method: meth });
  return res.json();
}

async function chromeUp() {
  if (!curPort) return false;
  try { await httpJson("GET", "/json/version"); return true; } catch { return false; }
}

function sanitizeName(name) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`invalid profile name "${name}" (allowed: letters, digits, -, _)`);
  return name;
}

function resolveProfile(name) {
  if (name !== undefined && name !== null && name !== "") {
    sanitizeName(name);
    return { name, dir: path.join(PROFILES_DIR, name), persistent: true };
  }
  if (PROFILE) return { name: null, dir: PROFILE, persistent: true }; // AB_PROFILE env: persistent default
  return { name: null, dir: fs.mkdtempSync(path.join(HOME, "tmp-profile-")), persistent: false };
}

function checkProfileFree(p) {
  // reject if another live Chrome holds this profile dir (SingletonLock "host-pid" — POSIX Chrome only)
  if (IS_WIN) return; // Windows Chrome has no SingletonLock symlink; .agent-browser.lock covers cross-server
  const lock = path.join(p.dir, "SingletonLock");
  try {
    const target = fs.readlinkSync(lock);
    const pid = Number(target.split("-").pop());
    if (pid && Number.isFinite(pid)) {
      try { process.kill(pid, 0); throw new Error(`profile ${p.name ? `"${p.name}"` : p.dir} is in use by pid ${pid}`); }
      catch (e) { if (String(e).includes("in use by")) throw e; }
    }
  } catch (e) { if (String(e).includes("in use by")) throw e; /* no lock or stale */ }
}

// Single-writer lock for named profiles: atomic O_EXCL lock file with pid +
// liveness check (stale locks from crashed servers are reclaimed). Replaces
// bare Chrome SingletonLock reliance for cross-server coordination.
function acquireProfileLock(p) {
  fs.mkdirSync(p.dir, { recursive: true });
  const lockPath = path.join(p.dir, ".agent-browser.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try { holder = Number(fs.readFileSync(lockPath, "utf8").trim()); } catch {}
      if (holder === process.pid) { try { fs.rmSync(lockPath, { force: true }); } catch {} continue; } // re-own our own lock
      if (holder && Number.isFinite(holder)) {
        try { process.kill(holder, 0); return { busy: true, holder }; } catch {} // holder dead → stale
      }
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }
  }
  return { busy: true, holder: null };
}

function releaseProfileLock(p) {
  if (!p) return;
  try { fs.rmSync(path.join(p.dir, ".agent-browser.lock"), { force: true }); } catch {}
}

// Per-launch CDP port: default AB_PORT, but if something already listens
// (another server's Chrome), take the next free port so parallel servers
// never collide on the debug channel.
let curPort = null;
function portTaken(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1", timeout: 300 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}
async function pickPort() {
  for (let p = PORT; p < PORT + 100; p++) {
    if (!(await portTaken(p))) { curPort = p; return p; }
  }
  throw new Error(`no free CDP port in ${PORT}..${PORT + 99}`);
}

async function launchChrome() {
  await inheritSessionEnv(); // fresh live-session env on every launch (theme vars, XAUTHORITY)
  const p = curProfile;
  const bin = findChromeSync();
  if (!bin) throw new Error("No Chrome/Chromium binary found; set AB_CHROME");
  if (p.persistent) {
    const lock = acquireProfileLock(p);
    if (lock && lock.busy) {
      curProfile = null;
      const err = new Error(`profile "${p.name ?? p.dir}" is busy (held by pid ${lock.holder ?? "unknown"})`);
      err.busy = { error: "busy", profile: p.name, holderPid: lock.holder ?? null, retryAfterMs: 2000 };
      throw err;
    }
    checkProfileFree(p);
  }
  fs.mkdirSync(p.dir, { recursive: true });
  fs.mkdirSync(path.join(HOME, "screenshots"), { recursive: true });
  const port = await pickPort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${p.dir}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--test-type", // suppress the "unsupported command-line flag" infobar (visible + fingerprint tell)
    "--hide-crash-restore-bubble", // kill-based switches would otherwise show "Restore pages?"
    "--disable-popup-blocking", // agent-driven el.click() has no user activation; _blank/order flows must open tabs
    `--window-size=1920,1080`,
  ];
  let headless = curHeadless ?? HEADLESS;
  // headless default ozone screen is 800x600 — a fingerprint tell next to a 1920 window.
  // Pin the virtual screen to 1080p; inner viewport lands at 1920x937 (maximized-like).
  if (headless) args.push("--ozone-override-screen-size=1920,1080");
  const hasDisplay = IS_WIN || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!headless && !hasDisplay) {
    headless = true; // no display available (e.g. minimal service env) — fall back rather than crash-loop
  }
  if (headless) args.push("--headless=new");
  // headful: pick the backend the LIVE session actually provides. Chrome's
  // default choice can fall back to a bare X11/default 800x600 screen even
  // when WAYLAND_DISPLAY is set → unthemed, wrong geometry. Deterministic:
  // Wayland session → --ozone-platform=wayland; X11-only → x11. Position stays
  // compositor-owned on Wayland; the CDP work-area clamp sizes the window.
  if (!headless) {
    if (process.env.WAYLAND_DISPLAY) args.push("--ozone-platform=wayland");
    else if (process.env.DISPLAY) args.push("--ozone-platform=x11");
  }
  if (process.env.AB_EXTRA_ARGS) args.push(...process.env.AB_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  chromeProc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const chromePid = chromeProc.pid;
  lastChromePid = chromePid;
  let stderrTail = "";
  let exited = null; // {code, signal} once known
  exitWaiter = new Promise((res) => { exitResolve = res; });
  chromeProc.stderr.setEncoding("utf8");
  chromeProc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  chromeProc.on("exit", (code, signal) => {
    exited = { code, signal };
    chromeProc = null; ws = null; wsTargetId = null;
    if (exitResolve) { exitResolve(); exitResolve = null; }
    if (lastChromePid === chromePid) lastChromePid = null;
  });
  chromeProc.on("error", (e) => {
    exited = exited || { code: null, signal: null, error: String(e?.message || e) };
    chromeProc = null;
  });
  for (let i = 0; i < 60; i++) {
  if (await chromeUp()) { lastChromePid = chromePid; return; }
    if (exited) {
      const why = exited.error || `exit code ${exited.code ?? "?"}${exited.signal ? " (signal " + exited.signal + ")" : ""}`;
      const lines = stderrTail.split("\n").filter(l => /error|fatal|cannot|failed|missing|not found/i.test(l)).slice(-5);
      throw new Error(`Chrome exited immediately (${why})${lines.length ? "; stderr: " + lines.join(" | ") : stderrTail ? "; stderr: " + stderrTail.slice(-500) : "; (no stderr)"}`);
    }
    await sleep(500);
  }
  throw new Error("Chrome did not open its debug port in 30s" + (exited ? ` (exited: ${JSON.stringify(exited)})` : " (still running but no CDP; another Chrome may hold the profile — check SingletonLock)"));
}

async function ensureTab() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  let targets = await httpJson("GET", "/json/list");
  let page = targets.find(t => t.type === "page" && !t.url.startsWith("devtools"));
  if (!page) {
    page = await httpJson("PUT", "/json/new?about:blank");
  }
  wsTargetId = page.id;
  await openWs(page.webSocketDebuggerUrl);
  await applyOverrides();
}

// --- Tabs: multi-tab support -------------------------------------------------
async function listTabs() {
  const t = await httpJson("GET", "/json/list");
  return t.filter(x => x.type === "page");
}
// Switch the driver's page-level CDP session to another tab (by targetId).
async function switchTab(targetId) {
  const tabs = await listTabs();
  const tab = tabs.find(t => t.id === targetId);
  if (!tab) throw new Error(`tab not found: ${targetId}`);
  try { ws && ws.close(); } catch {}
  ws = null;
  refs.clear(); // element refs are per-tab
  wsTargetId = tab.id;
  await openWs(tab.webSocketDebuggerUrl);
  await applyOverrides();
  return tab;
}
// browser_tabs accepts exactly: action, tabIndex, targetId. Unknown keys are
// rejected loudly instead of being silently ignored (e.g. {index: 1} used to
// degrade into a no-op list).
function assertTabArgs(args, extra = []) {
  const allowed = new Set(["action", "tabIndex", "targetId", ...extra]);
  for (const k of Object.keys(args || {}))
    if (!allowed.has(k)) throw new Error(`unknown parameter "${k}" — browser_tabs takes action, tabIndex, targetId (canonical selector is tabIndex; there is no "index" param)`);
}

async function tabSummaries() {
  const tabs = await listTabs();
  lastListedIds = tabs.map(t => t.id); // canonical index order for tabIndex resolution
  return tabs.map((t, i) => ({ index: i, targetId: t.id, url: t.url, title: t.title, active: t.id === wsTargetId }));
}
// Stable tab indexes: tabIndex N refers to the Nth tab of the MOST RECENT list
// the caller saw (browser_tabs list / any response carrying tab summaries), not
// to whatever /json/list happens to return now (Chrome lists newest-first, so a
// tab created since the last list would silently shift every index).
let lastListedIds = null;
async function resolveTabIndex(tabIndex) {
  const n = Number(tabIndex);
  if (lastListedIds) {
    const id = lastListedIds[n];
    if (!id) throw new Error(`tabIndex ${n} out of range (last list had 0..${lastListedIds.length - 1}) — call browser_tabs(action:"list") for fresh indexes`);
    const live = (await listTabs()).some(t => t.id === id);
    if (!live) throw new Error(`tab at index ${n} (from the last list) no longer exists — call browser_tabs(action:"list") for fresh indexes`);
    return id;
  }
  // No list seen yet in this session: fall back to current order, but say so.
  const tabs = await listTabs();
  const id = tabs[n]?.id;
  if (!id) throw new Error(`tabIndex ${n} out of range (0..${tabs.length - 1}) — and no prior list this session; call browser_tabs(action:"list") first for stable indexes`);
  return id;
}
// Piggyback notification: compare current tab set against the last snapshot;
// report added/removed tabs so the agent learns about _blank spawns on its
// very next tool call. Returns null when nothing changed.
let lastTabsSnapshot = null; // Map targetId -> {url,title}
async function tabsChanged() {
  if (!curPort || !(await chromeUp())) { lastTabsSnapshot = null; return null; }
  let tabs;
  try { tabs = await listTabs(); } catch { return null; }
  const snap = new Map(tabs.map(t => [t.id, { url: t.url, title: t.title }]));
  if (!lastTabsSnapshot) { lastTabsSnapshot = snap; return null; } // baseline after launch
  const added = [], removed = [];
  for (const [id, info] of snap) if (!lastTabsSnapshot.has(id)) added.push(info);
  for (const id of lastTabsSnapshot.keys()) if (!snap.has(id)) removed.push(id);
  lastTabsSnapshot = snap;
  if (!added.length && !removed.length) return null;
  return { count: snap.size, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) };
}
// After an in-page action (click/press), detect a tab opened via target=_blank /
// window.open and follow it: the driver switches to the new tab so subsequent
// read/click calls address the page the user just landed on.
async function followNewTab(beforeIds) {
  for (let i = 0; i < 10; i++) {
    const tabs = await listTabs();
    const fresh = tabs.find(t => !beforeIds.has(t.id));
    if (fresh) {
      await switchTab(fresh.id);
      await sleep(500); // let the new page start loading
      return true;
    }
    await sleep(300);
  }
  return false;
}

// Consistency overrides applied per tab: timezone pinned to Europe/Moscow
// (match exit IP), UA normalized (headless=new can still leak "Headless"),
// languages ru-RU. Raises the bar; CDP remains detectable in principle.
const TZ = process.env.AB_TZ || "Europe/Moscow";
async function applyOverrides() {
  try { await cdp("Emulation.setTimezoneOverride", { timezoneId: TZ }); } catch {}
  // clean profiles have no chrome.runtime (no extensions) — commodity bot checks expect it.
  // Inject a minimal shim before page scripts on every navigation; harmless on real Chrome.
  try {
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
      try {
        if (window.chrome && !window.chrome.runtime) {
          Object.defineProperty(window.chrome, "runtime", { value: {
            connect: function(){ return {onMessage:{addListener:function(){}}, postMessage:function(){}}; },
            sendMessage: function(){}, id: undefined, getURL: function(p){ return "chrome-extension://invalid/" + p; }
          }, configurable: true });
        }
      } catch (e) {}` });
  } catch {}
  try {
    const ua = await evalJs("navigator.userAgent");
    if (/Headless/i.test(ua || "")) {
      await cdp("Emulation.setUserAgentOverride", {
        userAgent: ua.replace(/Headless/, "").replace(/\s+/g, " "),
        acceptLanguage: "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        platform: "Linux x86_64",
      });
    }
  } catch {}
}

// --- Zombie defense: make THIS server a subreaper (bun only, via bun:ffi prctl) ---------------
// Under openclaw's node host, the service-child-group-anchor is a subreaper that never
// waits: any chrome descendant that outlives its parent orphans to it and stays a zombie.
// If we are a subreaper ourselves, those orphans reparent to US (nearest subreaper), and
// a waitpid(-1, WNOHANG) loop reaps them. Plain-node hosts keep the staged-shutdown path.
let reapWaitpid = null;
async function enableSubreaper() {
  if (IS_WIN) return false;
  try {
    const { dlopen } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl:   { args: ["i32", "i64", "i64", "i64", "i64"], returns: "i32" },
      waitpid: { args: ["i32", "pointer", "i32"], returns: "i32" },
    });
    if (libc.symbols.prctl(36 /* PR_SET_CHILD_SUBREAPER */, 1, 0, 0, 0) !== 0) return false;
    reapWaitpid = () => { try { while (libc.symbols.waitpid(-1, null, 1) > 0) {} } catch {} };
    const t = setInterval(reapWaitpid, 1000); t.unref?.();
    return true;
  } catch { return false; }
}
enableSubreaper(); // fire and forget; reapWaitpid stays null on failure

function openWs(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        { const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result); }
      }
    };
    // Only clear the global if THIS socket is still the current one — a stale
    // socket's late close event must not clobber a newer one assigned by switchTab.
    sock.onclose = () => { if (ws === sock) ws = null; };
    sock.onopen = () => resolve();
    sock.onerror = (e) => reject(new Error("CDP websocket error"));
    ws = sock;
  });
}

// --- Headful geometry: probe the real logical work area via CDP (Wayland-correct) -------------
// xrandr lies under fractional scaling; kscreen-doctor is KDE-only. Instead: after a headful
// launch, maximize the window via the BROWSER-level CDP endpoint, read its bounds back
// (= the compositor's work area in logical px, panels/dock excluded by construction), then
// set a normal window fit inside it with small margins, anchored top-left.
let browserWs = null;
const browserPending = new Map();
let browserMsgId = 0;
async function browserCdp(method, params = {}) {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
    const v = await httpJson("GET", "/json/version");
    browserWs = await new Promise((resolve, reject) => {
      const w = new WebSocket(v.webSocketDebuggerUrl);
      w.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id && browserPending.has(m.id)) {
            const { resolve, reject } = browserPending.get(m.id);
            browserPending.delete(m.id);
            m.error ? reject(new Error(m.error.message || JSON.stringify(m.error))) : resolve(m.result);
          }
        } catch {}
      };
      w.onclose = () => { if (browserWs === w) browserWs = null; };
      w.onopen = () => resolve(w);
      w.onerror = () => reject(new Error("browser CDP ws error"));
    });
  }
  const id = ++browserMsgId;
  return new Promise((resolve, reject) => {
    browserPending.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (browserPending.has(id)) { browserPending.delete(id); reject(new Error(`browser CDP timeout: ${method}`)); }
    }, 10000);
  });
}

let workArea = null; // {width, height} logical work area of the current headful launch
let lastWindowBounds = null; // final post-clamp window rect + workArea (for QA/smoke)
async function fitHeadfulWindow() {
  // called after the first tab exists on a headful launch
  if (!wsTargetId) return;
  try {
    const { windowId } = await browserCdp("Browser.getWindowForTarget", { targetId: wsTargetId });
    await browserCdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    await sleep(500); // let the compositor apply it
    const { bounds } = await browserCdp("Browser.getWindowForTarget", { targetId: wsTargetId });
    if (bounds?.width > 0 && bounds?.height > 0) {
      workArea = { width: bounds.width, height: bounds.height };
      // CDP quirk: size is dropped when the same call flips windowState maximized→normal.
      await browserCdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await sleep(250);
      // On Wayland the compositor owns placement: setWindowBounds left/top are
      // ignored (and the readback is client-side fiction), so clamping position
      // is useless. Instead CAP THE SIZE to ~90% of the work area — any sane
      // placement policy (centered/cascade/smart) then keeps the window fully
      // on-screen without us knowing or caring which compositor is running.
      const sizeBounds = {
        width: Math.max(400, Math.floor(bounds.width * 0.9)),
        height: Math.max(300, Math.floor(bounds.height * 0.88)),
      };
      await browserCdp("Browser.setWindowBounds", { windowId, bounds: sizeBounds });
      await sleep(400);
      const final = (await browserCdp("Browser.getWindowForTarget", { targetId: wsTargetId })).bounds || {};
      lastWindowBounds = {
        left: Math.round(final.left ?? 0), top: Math.round(final.top ?? 0),
        width: Math.round(final.width ?? sizeBounds.width), height: Math.round(final.height ?? sizeBounds.height),
        // note: left/top under Wayland are the client's belief, not compositor truth
        workArea: { width: bounds.width, height: bounds.height },
      };
    }
  } catch (e) { console.error("[agent-browser] headful geometry probe failed:", e?.message || e); }
}

async function cdp(method, params = {}, sessionId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("browser not running (call any browser_* tool to relaunch)");
  const id = ++msgId;
  const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { ws.send(payload); } catch (e) { pending.delete(id); reject(new Error(`CDP send failed: ${method}: ${e.message}`)); return; }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        // navigate/screenshot can exceed a short timeout on slow pages; retry
        // once when the socket is still healthy before giving up.
        if ((method === "Page.navigate" || method === "Page.captureScreenshot") && ws && ws.readyState === WebSocket.OPEN && !cdpRetried.has(id)) {
          cdpRetried.add(id);
          cdp(method, params, sessionId).then(resolve, reject);
          return;
        }
        reject(new Error(`CDP timeout: ${method} (no reply in 30s${method === "Page.captureScreenshot" ? " — page may still be busy rendering" : ""}; socket was ${ws ? (ws.readyState === WebSocket.OPEN ? "open" : "closing") : "gone"})`));
      }
    }, 30000);
  });
}
const cdpRetried = new Set();

let curHeadless = null; // headless mode of the running launch (bool)
let exitWaiter = null, exitResolve = null;
// Ask a running chrome to shut down gracefully and WAIT for it: chrome reaps its own
// children (crashpad, gpu, zygotes) as they exit during graceful shutdown. Killing the
// main process early orphans them to the nearest subreaper (the node host) → zombies.
async function shutdownChrome(timeoutMs = 4000) {
  const pid = chromeProc?.pid ?? lastChromePid;
  const waiter = exitWaiter;
  if (pid == null) return;
  if (IS_WIN) {
    killTree(pid); // taskkill /T /F walks the tree; Windows has no zombie problem
    await sleep(700);
    return;
  }
  // Staged POSIX shutdown so every grandchild dies while SOMEONE alive can reap it.
  // (If the zygote dies before its renderers, they orphan to the nearest subreaper —
  // the node host's group anchor — which never waits, leaving zombies.)
  // wave 0: ask the main process to shut down gracefully FIRST — chrome terminates and
  // reaps its own children on the way down, which orphans nobody.
  try { process.kill(pid, "SIGTERM"); } catch {}
  if (waiter) await Promise.race([waiter, sleep(2500)]);
  if (!chromeProc && lastChromePid !== pid) {
    reapWaitpid?.();
    return; // graceful exit completed; chrome reaped its own tree
  }
  const kids = groupMembers(pid).filter((p) => p !== pid);
  // kill deepest-first: build a ppid map and sort by generation so children die while their
  // parent lives and can reap them (renderers → zygote → main).
  const ppidOf = new Map([[pid, null]]);
  for (const k of kids) ppidOf.set(k, null);
  for (let pass = 0; pass < 8; pass++) {
    for (const k of kids) {
      if (ppidOf.get(k) !== null) continue;
      try {
        const st = fs.readFileSync(`/proc/${k}/stat`, "utf8");
        const pp = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
        ppidOf.set(k, ppidOf.has(pp) ? pp : -1);
      } catch { ppidOf.set(k, -1); }
    }
  }
  const depth = (p, d = 0) => { const pp = ppidOf.get(p); return pp && pp > 0 ? 1 + depth(pp) : d; };
  kids.sort((a, b) => depth(b) - depth(a));
  for (const k of kids) { try { process.kill(k, "SIGTERM"); } catch {} } // wave 1: descendants, deepest first
  await sleep(300); // let parents reap them before the next wave
  kids.forEach((k) => { try { process.kill(k, "SIGKILL"); } catch {} }); // sweep stragglers while main lives
  if (waiter) await Promise.race([waiter, sleep(Math.min(timeoutMs, 2000))]);
  if (chromeProc || lastChromePid === pid) {
    try { process.kill(pid, "SIGTERM"); } catch {} // wave 2: the leader
    if (waiter) await Promise.race([waiter, sleep(2000)]);
  }
  if (chromeProc || lastChromePid === pid) {
    killTree(pid); // wave 3: force
    if (waiter) await Promise.race([waiter, sleep(1500)]);
  }
  reapWaitpid?.();
}
async function ensureBrowser(profileName, headlessOpt) {
  touchIdle();
  const wantHeadless = headlessOpt === undefined ? undefined : !!headlessOpt;
  const desired = profileName ?? null;
  const running = await chromeUp();
  if (running) {
    // implicit addressing: while a browser is open, an omitted profile means "the current
    // browser" (agents do open(profile:X) then plain read/click/open). Only an explicit,
    // DIFFERENT profile (or headless change) restarts.
    const desiredName = desired === null ? (curProfile?.name ?? null) : (resolveProfile(desired).name ?? null);
    const switchProfile = desiredName !== (curProfile?.name ?? null);
    const switchMode = wantHeadless !== undefined && curHeadless !== null && wantHeadless !== curHeadless;
    if (switchProfile || switchMode) {
      await closeChrome(); // restart with new profile / headless mode
    } else {
      return ensureTab();
    }
  }
  // no browser running: omitted profile = FRESH throwaway (AB_PROFILE env default still applies).
  // Never resurrect the last-used named profile.
  curProfile = resolveProfile(desired);
  lastRequested = desired;
  curHeadless = wantHeadless ?? HEADLESS;
  refs.clear();
  try {
    await launchChrome();
  } catch (e) {
    if (e.busy) { curProfile = null; lastRequested = desired ?? null; throw e; }
    releaseProfileLock(curProfile); curProfile = null;
    throw e;
  }
  await ensureTab();
  if (!curHeadless) await fitHeadfulWindow(); // headful window must fit the real logical work area
}

async function evalJs(expr) {
  const r = await cdp("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error("page JS error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

async function navigate(url) {
  lastNavAt = Date.now();
  await cdp("Page.enable");
  await cdp("Page.navigate", { url });
  await sleep(700);
}

async function currentPage() {
  const r = await evalJs("JSON.stringify({url: location.href, title: document.title})");
  return JSON.parse(r);
}

// ------------------------------------------------------- idle auto-close
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  if (IDLE_S > 0) idleTimer = setTimeout(closeChrome, IDLE_S * 1000);
}

export async function closeChrome(opts = {}) {
  if (idleTimer) clearTimeout(idleTimer);
  try { if (ws) ws.close(); } catch {}
  ws = null;
  if (chromeProc) {
    try { await httpJson("GET", "/json/close/" + (wsTargetId || "")); } catch {}
    await shutdownChrome();
  }
  chromeProc = null;
  const p = curProfile;
  let wiped = false, profile = p?.name ?? null;
  releaseProfileLock(p);
  curProfile = null;
  curHeadless = null;
  if (p) {
    if (!p.persistent || opts.discard) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { fs.rmSync(p.dir, { recursive: true, force: true }); wiped = true; } catch {}
        // crashpad/telemetry children can outlive the chrome main briefly and
        // recreate the dir after the wipe — verify and retry.
        if (!fs.existsSync(p.dir)) break;
        await sleep(300);
      }
      wiped = wiped && !fs.existsSync(p.dir);
    }
    if (opts.discard && lastRequested === p.name) lastRequested = null;
  }
  return { closed: true, profile, wiped };
}

// ------------------------------------------------------------ ref logic
// CSS path robust enough between snapshots on the same DOM (nth-of-type chain).
const SNAPSHOT_JS = `(() => {
  const els = [];
  const cssPath = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let s = el.tagName.toLowerCase();
      let n = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) n++;
      if (n > 1) s += ":nth-of-type(" + n + ")";
      parts.unshift(s);
      el = el.parentElement;
    }
    return "html > " + parts.join(" > ");
  };
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [contenteditable="true"]';
  document.querySelectorAll(sel).forEach((el) => {
    if (els.length >= 400) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const label = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.alt || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    els.push({ tag: el.tagName.toLowerCase(), label, path: cssPath(el) });
  });
  return JSON.stringify(els);
})()`;

function buildRefs(els) {
  refs = new Map();
  els.forEach((e, i) => refs.set("e" + (i + 1), e.path));
  return els.map((e, i) => `e${i + 1} ${e.tag} ${e.label ? "'" + e.label + "'" : ""}`.trimEnd());
}

async function resolveTarget(arg) {
  if (arg.ref) {
    const p = refs.get(arg.ref);
    if (!p) throw new Error(`unknown ref ${arg.ref} — take a fresh snapshot with browser_read(mode="snapshot")`);
    const ok = await evalJs(`!!document.querySelector(${JSON.stringify(p)})`);
    if (!ok) throw new Error(`ref ${arg.ref} is stale — take a fresh snapshot`);
    return p;
  }
  if (arg.text) {
    const found = await evalJs(`(() => {
      const want = ${JSON.stringify(arg.text.toLowerCase())};
      const sel = 'a[href], button, input, select, textarea, [role="button"], [onclick]';
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (t === want || t.includes(want)) return true;
      }
      return false;
    })()`);
    if (!found) throw new Error(`no clickable element with text ~ ${JSON.stringify(arg.text)}`);
    return null; // click by text via JS below
  }
  throw new Error("provide ref or text");
}

// -------------------------------------------------------- confirm gates
const RISKY = [
  "отправ", "опублик", "размест", "удал", "оплат", "купит", "заказ", "подтверд",
  "продвин", "подключ", "примен", "записат", "сохран", "в архив", "снять с публик",
  "показать телефон", "выйти",
  "send", "submit", "publish", "delete", "remove", "pay", "purchase", "buy",
  "order", "confirm", "promote", "apply", "book", "save", "sign out", "log out",
  "unsubscribe", "transfer", "withdraw",
];

async function needsConfirm(kind, detail) {
  if (detail.confirm) return false;
  const hay = (detail.label || detail.text || "").toLowerCase();
  if (RISKY.some(w => hay.includes(w))) return true;
  if (kind === "press" && (detail.key === "Enter")) return true; // Enter may submit
  return false;
}

// ------------------------------------------------------------- tools
const tools = {
  browser_status: async () => {
    await ensureBrowser();
    return currentPage();
  },

  browser_open: async ({ url, profile, headless, newTab, tabIndex }) => {
    try {
      await ensureBrowser(profile, headless);
    } catch (e) {
      if (e.busy) return e.busy; // {error:'busy', profile, holderPid, retryAfterMs}
      throw e;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    let tabNote = null;
    if (newTab && tabIndex !== undefined) throw new Error("pass either newTab or tabIndex, not both");
    if (newTab) {
      const t = await browserCdp("Target.createTarget", { url: "about:blank" });
      await switchTab(t.targetId);
      tabNote = { newTab: true, targetId: t.targetId };
    } else if (tabIndex !== undefined) {
      const id = await resolveTabIndex(tabIndex);
      if (id !== wsTargetId) { await switchTab(id); tabNote = { focused: Number(tabIndex), targetId: id }; }
    }
    await navigate(url);
    return { ...await currentPage(), profile: curProfile?.name ?? null, persistent: !!curProfile?.persistent, headless: !!curHeadless, chromePid: chromeProc?.pid ?? lastChromePid, ...(tabNote ? { tab: tabNote } : {}), ...(lastWindowBounds ? { window: lastWindowBounds } : {}) };
  },

  browser_tabs: async (args) => {
    const { action = "list", tabIndex, targetId } = args;
    assertTabArgs(args, []);
    await ensureBrowser();
    if (action === "list") {
      if (tabIndex !== undefined || targetId) throw new Error("action=list takes no tab selector — use focus or close with tabIndex/targetId");
      return { tabs: await tabSummaries(), activeTargetId: wsTargetId };
    }
    if (action === "focus") {
      assertTabArgs(args, []);
      let id = targetId ?? null;
      if (!id && tabIndex !== undefined) id = await resolveTabIndex(tabIndex);
      if (!id) throw new Error("focus needs tabIndex or targetId");
      const tab = await switchTab(id);
      return { focused: true, targetId: tab.id, ...(await currentPage()) };
    }
    if (action === "close") {
      assertTabArgs(args, []);
      let id = targetId ?? null;
      if (!id && tabIndex !== undefined) id = await resolveTabIndex(tabIndex);
      if (!id) throw new Error("close needs tabIndex or targetId");
      const wasActive = id === wsTargetId;
      await browserCdp("Target.closeTarget", { targetId: id });
      // wait until the tab is REALLY gone from the list — a fresh list taken
      // too early can still include it, making switchedTo point at the closed tab
      let tabs = [];
      for (let i = 0; i < 15; i++) {
        await sleep(100);
        tabs = await listTabs();
        if (!tabs.some(t => t.id === id)) break;
      }
      tabs = tabs.filter(t => t.id !== id);
      if (wasActive || !ws || ws.readyState !== WebSocket.OPEN) {
        ws = null; // force re-attach to a remaining tab on next use
        if (tabs.length) { await switchTab(tabs[0].id); return { closed: true, switchedTo: tabs[0].id, ...(await currentPage()) }; }
      }
      return { closed: true, tabs: await tabSummaries() };
    }
    throw new Error(`unknown action "${action}" (list|focus|close)`);
  },

  // browser_tabs accepts exactly: action, tabIndex, targetId. Unknown keys are
  // rejected loudly instead of being silently ignored (e.g. {index: 1} used to
  // degrade into a no-op list).
  // (assertTabArgs is defined below, hoisted as a function declaration.)

  browser_back: async () => {
    await ensureBrowser();
    await evalJs("history.back()");
    await sleep(500);
    return currentPage();
  },

  browser_read: async ({ mode = "text", offset = 0, max_chars = 4000, wait_for_text, viewport_only = false }) => {
    await ensureBrowser();
    if (wait_for_text) {
      for (let i = 0; i < 15; i++) {
        const has = await evalJs(`document.body && document.body.innerText.includes(${JSON.stringify(wait_for_text)})`);
        if (has) break;
        await sleep(1000);
      }
    }
    if (mode === "snapshot") {
      const els = JSON.parse(await evalJs(SNAPSHOT_JS));
      const lines = buildRefs(els);
      return { lines: lines.slice(offset, offset + max_chars / 40 | 0), total: lines.length };
    }
    const text = JSON.parse(await evalJs(viewport_only
      ? "JSON.stringify(Array.from(document.querySelectorAll('body *')).filter(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}).map(e=>e.innerText).join('\\n'))"
      : "JSON.stringify(document.body ? document.body.innerText : '')"));
    return { text: text.slice(offset, offset + max_chars), total: text.length, offset };
  },

  browser_click: async (arg) => {
    await ensureBrowser();
    const beforeIds = new Set((await listTabs()).map(t => t.id)); // to detect target=_blank spawns
    const label = arg.ref ? await evalJs(`(() => { const p=${JSON.stringify(refs.get(arg.ref)||"")}; const el=document.querySelector(p); return el ? (el.innerText||el.value||el.getAttribute("aria-label")||"").trim().slice(0,80) : ""; })()`) : (arg.text || "");
    if (await needsConfirm("click", { ...arg, label })) {
      return { needs_confirmation: true, hint: `re-call with confirm=true to click "${label || arg.ref}"` };
    }
    const path = await resolveTarget(arg);
    let blank = false;
    if (path) {
      blank = await evalJs(`(function(){ const el = document.querySelector(${JSON.stringify(path)}); el.scrollIntoView({block:"center"}); const r = !!(el.closest && el.closest('a[target=_blank]')); el.click(); return r; })()`);
    } else {
      blank = await evalJs(`(function(){
        const want = ${JSON.stringify((arg.text || "").toLowerCase())};
        const sel = 'a[href], button, input, select, textarea, [role="button"], [onclick]';
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (t === want || t.includes(want)) { el.scrollIntoView({block:"center"}); const r = !!(el.closest && el.closest('a[target=_blank]')); el.click(); return r; }
        }
      })()`);
    }
    await sleep(400);
    const opened = blank ? await followNewTab(beforeIds) : false;
    return { ...(await currentPage()), ...(opened ? { newTab: true, tabCount: (await listTabs()).length } : {}) };
  },

  browser_hover: async ({ ref }) => {
    await ensureBrowser();
    const p = refs.get(ref);
    if (!p) throw new Error("unknown ref; fresh snapshot needed");
    await evalJs(`document.querySelector(${JSON.stringify(p)}).dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
    return { ok: true };
  },

  browser_type: async ({ ref, text, clear = true, submit = false, confirm = false }) => {
    await ensureBrowser();
    if (submit && !confirm) return { needs_confirmation: true, hint: "submit=true presses Enter; re-call with confirm=true" };
    const p = refs.get(ref);
    if (!p) throw new Error("unknown ref; fresh snapshot needed");
    const value = await evalJs(`(function(){
      const el = document.querySelector(${JSON.stringify(p)});
      el.focus();
      if (${clear}) { el.value = ""; }
      ${text.includes("\n") ? "" : ""}
      // set value via native setter so frameworks notice
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    })()`);
    if (submit) {
      await evalJs(`document.querySelector(${JSON.stringify(p)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
      await sleep(400);
    }
    return { value };
  },

  browser_press: async ({ key, confirm = false }) => {
    await ensureBrowser();
    if (await needsConfirm("press", { key })) return { needs_confirmation: true, hint: `re-call with confirm=true to press ${key}` };
    const k = key === "Enter" ? "Enter" : key;
    await evalJs(`(function(){
      const tgt = document.activeElement || document.body;
      for (const type of ["keydown","keyup"]) tgt.dispatchEvent(new KeyboardEvent(type,{key:${JSON.stringify(k)},bubbles:true}));
    })()`);
    await sleep(200);
    return currentPage();
  },

  browser_scroll: async ({ direction = "down", screens = 1 }) => {
    await ensureBrowser();
    const map = { down: `scrollBy(0, innerHeight*${screens})`, up: `scrollBy(0, -innerHeight*${screens})`, top: "scrollTo(0,0)", bottom: "scrollTo(0, document.body.scrollHeight)" };
    await evalJs(map[direction] || map.down);
    await sleep(300);
    return { ok: true };
  },

  browser_screenshot: async ({ full_page = false } = {}) => {
    await ensureBrowser();
    if (full_page) {
      await evalJs(`document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0,0)`);
      await sleep(200);
    }
    const r = await cdp("Page.captureScreenshot", { format: "png", ...(full_page ? { captureBeyondViewport: true } : {}) });
    const file = path.join(HOME, "screenshots", new Date().toISOString().replace(/[:.]/g, "-") + ".png");
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return { file };
  },

  browser_eval: async ({ expression }) => {
    await ensureBrowser();
    const v = await evalJs(expression);
    return { value: v === undefined ? null : v };
  },

  browser_close: async ({ discard = false, profile } = {}) => {
    if (profile !== undefined && (curProfile?.name ?? null) !== (profile || null)) {
      throw new Error(curProfile ? `current profile is ${JSON.stringify(curProfile.name)}, not ${JSON.stringify(profile)}` : "no browser running");
    }
    return await closeChrome({ discard });
  },

  browser_wait: async ({ seconds = 5 }) => {
    await ensureBrowser();
    await sleep(Math.min(seconds, 60) * 1000);
    return currentPage();
  },
};

// ------------------------------------------------------------ MCP stdio
const TOOL_DEFS = [
  { name: "browser_status", description: "Launch the dedicated browser if needed; return current url/title", inputSchema: { type: "object", properties: {} } },
  { name: "browser_open", description: "Navigate to a URL. Optional profile: named persistent profile (~/.agent-browser/profiles/<name>/, cookies/storage survive); omit for a throwaway profile (default; wiped on close). headless: true/false overrides AB_HEADLESS for this launch (headless recommended for automation/cron; headful is for interactive/human-login use). Switching profile or headless mode restarts the browser. newTab: open in a NEW tab and switch to it. tabIndex: focus an existing tab (by index) and navigate it. Responses may carry tabs_changed when sites spawn/close tabs.", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" }, profile: { type: "string", description: "[a-zA-Z0-9_-]; rejected if another Chrome is using it" }, headless: { type: "boolean" }, newTab: { type: "boolean" }, tabIndex: { type: "number" } } }, },
  { name: "browser_tabs", description: "Tab management. action=list returns tabs (index/targetId/url/title + activeTargetId); action=focus switches the driver to a tab (tabIndex or targetId); action=close closes one (tabIndex or targetId; closing the active tab switches to the first remaining). Indexes are STABLE: tabIndex N refers to the Nth tab of the most recent list you saw — after tabs spawn/close, re-list before using indexes again. Canonical selector param is tabIndex (no \"index\").", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "focus", "close"] }, tabIndex: { type: "number" }, targetId: { type: "string" } } } },
  { name: "browser_back", description: "Go back in history", inputSchema: { type: "object", properties: {} } },
  { name: "browser_read", description: "Read page: mode=text (visible text, paginated) or mode=snapshot (clickable elements with stable refs eN). wait_for_text waits up to 15s for text to appear.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["text", "snapshot"] }, offset: { type: "number" }, max_chars: { type: "number" }, wait_for_text: { type: "string" }, viewport_only: { type: "boolean" } } } },
  { name: "browser_click", description: "Click by ref (from snapshot) or visible text. Risky buttons (send/pay/delete/save/logout/submit etc.) require confirm=true", inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, confirm: { type: "boolean" } } } },
  { name: "browser_hover", description: "Hover over element by ref (opens dropdown menus)", inputSchema: { type: "object", required: ["ref"], properties: { ref: { type: "string" } } } },
  { name: "browser_type", description: "Type text into a field by ref; returns final field value. submit=true also presses Enter (needs confirm)", inputSchema: { type: "object", required: ["ref", "text"], properties: { ref: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" }, submit: { type: "boolean" }, confirm: { type: "boolean" } } } },
  { name: "browser_press", description: "Press a key (Enter, Escape, Tab, PageDown...). Enter needs confirm=true", inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" }, confirm: { type: "boolean" } } } },
  { name: "browser_scroll", description: "Scroll the page", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["down", "up", "top", "bottom"] }, screens: { type: "number" } } } },
  { name: "browser_screenshot", description: "Screenshot; saved under the server home dir, path returned", inputSchema: { type: "object", properties: { full_page: { type: "boolean" } } } },
  { name: "browser_eval", description: "Evaluate a JS expression in the page (Runtime.evaluate, awaited); returns {value}. Use for checks (navigator.webdriver etc.) and small scrapes.", inputSchema: { type: "object", required: ["expression"], properties: { expression: { type: "string" } } } },
  { name: "browser_close", description: "Close the browser now (reopens on next call). Named profiles persist by default; pass discard=true to wipe the current profile's data. profile: assert which profile is being closed.", inputSchema: { type: "object", properties: { discard: { type: "boolean" }, profile: { type: "string" } } } },
  { name: "browser_wait", description: "Wait N seconds (max 60), then return url/title", inputSchema: { type: "object", properties: { seconds: { type: "number" } } } },
];

// line-delimited JSON-RPC over stdio (MCP stdio transport uses LSP-style
// Content-Length headers only for some clients; the MCP spec uses
// newline-delimited JSON — that is what we implement).
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});
// stdio MCP lifecycle: when the host closes our stdin (restart/replacement),
// exit promptly instead of lingering as an orphan holding profile locks.
process.stdin.on("close", () => { shutdownOrphansAndExit(); });
process.stdin.on("end", () => { shutdownOrphansAndExit(); });
let exiting = false;
async function shutdownOrphansAndExit() {
  if (exiting) return;
  exiting = true;
  try { await closeChrome(); } catch {}
  setTimeout(() => process.exit(0), 200).unref?.();
  process.exit(0);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-browser", version: "1.0.0" } } });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // ignore
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOL_DEFS } });
    } else if (method === "tools/call") {
      const name = params.name;
      const fn = tools[name];
      if (!fn) throw new Error(`unknown tool ${name}`);
      const result = await fn(params.arguments || {});
      if (result && typeof result === "object" && !Array.isArray(result) && !result.needs_confirmation && !result.error) {
        const delta = await tabsChanged(); // piggyback: learn about _blank-spawned tabs on the next action
        if (delta) result.tabs_changed = delta;
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } else if (method) {
      send({ jsonrpc: "2.0", id, result: {}, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message || e) } });
  }
}

process.on("exit", () => {
  try { chromeProc?.kill("SIGKILL"); } catch {}
  if (lastChromePid) killTree(lastChromePid);
  try { if (curProfile && !curProfile.persistent) fs.rmSync(curProfile.dir, { recursive: true, force: true }); } catch {}
});
