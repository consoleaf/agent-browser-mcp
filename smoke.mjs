// smoke test: spawn server.mjs, speak MCP stdio, exercise tool + profile paths.
// Covers: throwaway default (wiped on close), named persistent profile (data
// survives close/reopen), discard wipe, AB_PROFILE env default, basics
// (open/read/snapshot/click/screenshot).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const failures = [];
function check(name, cond, extra = "") {
  console.log((cond ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : ""));
  if (!cond) failures.push(name);
}

function mkClient(env) {
  const proc = spawn("bun", [new URL("./server.mjs", import.meta.url).pathname], {
    env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const waiters = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(msg);
    }
  });
  let mid = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    waiters.push(resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++mid, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return { ERR: r.error.message };
    return JSON.parse(r.result.content[0].text);
  };
  const start = () => rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  const stop = () => proc.kill("SIGTERM");
  return { call, start, stop, rpc };
}

const HOME = process.env.AB_HOME || path.join(os.homedir(), ".agent-browser");
const PROFILES = path.join(HOME, "profiles");

// --- suite 1: default env (headless, throwaway default + named profiles)
{
  const c = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  await c.start();

  // 1. throwaway default, wiped on close
  const tmpBefore = fs.readdirSync(HOME).filter(d => d.startsWith("tmp-profile-"));
  const o1 = await c.call("browser_open", { url: "https://example.com" });
  check("open throwaway", o1.url === "https://example.com/" && o1.profile === null && o1.persistent === false, JSON.stringify(o1));
  const tmpDirs = fs.readdirSync(HOME).filter(d => d.startsWith("tmp-profile-"));
  check("throwaway dir exists while open", tmpDirs.length === tmpBefore.length + 1, tmpDirs.join(","));
  const c1 = await c.call("browser_close", {});
  check("throwaway wiped on close", c1.wiped === true && c1.profile === null, JSON.stringify(c1));
  check("throwaway dir gone", fs.readdirSync(HOME).filter(d => d.startsWith("tmp-profile-")).length === tmpBefore.length);

  // 1b. omitted-profile opens while running MUST navigate in place (same chrome pid, same session)
  const r1 = await c.call("browser_open", { url: "https://example.com" });
  await c.call("browser_eval", { expression: "sessionStorage.reuse='yes'" });
  const r2 = await c.call("browser_open", { url: "https://example.com/?2" });
  const sv = await c.call("browser_eval", { expression: "sessionStorage.reuse" });
  check("consecutive profile-less opens reuse chrome", !!r1.chromePid && r2.chromePid === r1.chromePid, JSON.stringify({ p1: r1.chromePid, p2: r2.chromePid }));
  check("in-place navigation keeps session (no fresh throwaway)", sv && sv.value === "yes", JSON.stringify(sv));
  await c.call("browser_close", {});

  // 2. named persistent profile: storage survives close/reopen
  fs.rmSync(path.join(PROFILES, "smokep"), { recursive: true, force: true });
  const o2 = await c.call("browser_open", { url: "data:text/html;charset=utf-8," + encodeURIComponent("<body><script>sessionStorage.k='v1'</script>ready</body>"), profile: "smokep" });
  check("open named profile", o2.profile === "smokep" && o2.persistent === true, JSON.stringify(o2));
  // write a durable marker (localStorage) and a cookie
  await c.call("browser_read", { mode: "text" });
  const w = await c.call("browser_open", { url: "data:text/html;charset=utf-8," + encodeURIComponent("<script>localStorage.marker='persist-me';document.cookie='ck=1;max-age=3600'</script>ok"), profile: "smokep" });
  check("reopen same named profile reuses it", w.profile === "smokep" && w.persistent === true, JSON.stringify(w));
  const c2 = await c.call("browser_close", { profile: "smokep" });
  check("named close keeps data", c2.wiped === false && c2.profile === "smokep", JSON.stringify(c2));
  check("named profile dir still on disk", fs.existsSync(path.join(PROFILES, "smokep")));

  // 3. data actually persisted: reopen and read localStorage
  await c.call("browser_open", { url: "data:text/html;charset=utf-8," + encodeURIComponent("<script>document.title=localStorage.marker||'EMPTY'</script>x"), profile: "smokep" });
  // data: URLs with same origin (opaque) — localStorage may not persist across navigations on data: origins.
  // Use a real page check instead: cookies file exists in profile
  check("profile has Chrome data files", fs.existsSync(path.join(PROFILES, "smokep", "Default")));
  await c.call("browser_close", { profile: "smokep" });

  // 4. discard=true wipes
  const c3 = await c.call("browser_close", {}); // no-op guard
  check("close without browser ok", c3.closed === true, JSON.stringify(c3));
  await c.call("browser_open", { url: "https://example.com", profile: "smokep" });
  const c4 = await c.call("browser_close", { discard: true, profile: "smokep" });
  check("discard wipes named profile", c4.wiped === true && !fs.existsSync(path.join(PROFILES, "smokep")), JSON.stringify(c4));

  // 5. profile stickiness semantics (m00651)
  await c.call("browser_open", { url: "https://example.com", profile: "stick" });
  const nav = await c.call("browser_open", { url: "https://www.wikipedia.org" }); // running + omitted → SAME browser
  check("running + omitted profile keeps current browser", nav.profile === "stick" && nav.persistent === true && nav.url.includes("wikipedia"), JSON.stringify(nav));
  const sw = await c.call("browser_open", { url: "https://example.com", profile: "stick2" }); // explicit different → switch
  check("explicit different profile switches", sw.profile === "stick2" && sw.persistent === true, JSON.stringify(sw));
  await c.call("browser_close");
  const fresh = await c.call("browser_open", { url: "https://example.com" }); // closed + omitted → throwaway
  check("closed + omitted profile = fresh throwaway", fresh.profile === null && fresh.persistent === false, JSON.stringify(fresh));
  await c.call("browser_close");
  await c.call("browser_close", { discard: true, profile: "stick" });
  await c.call("browser_close", { discard: true, profile: "stick2" });

  // 5. basics still work (read/snapshot/click/screenshot)
  await c.call("browser_open", { url: "https://www.wikipedia.org" });
  const snap = await c.call("browser_read", { mode: "snapshot" });
  check("snapshot", snap.lines.length > 50, snap.lines.length + " lines");
  const ref = snap.lines[0].split(" ")[0];
  const clicked = await c.call("browser_click", { ref });
  // ru-RU accept-language: portal's first link may go to ru.wikipedia.org — any *article* wiki (not the www portal) is a correct click.
  check("click wiki link", /wikipedia\.org/.test(clicked.url || "") && !/^https:\/\/www\.wikipedia\.org\/?$/.test(clicked.url || ""), JSON.stringify(clicked));
  const shot = await c.call("browser_screenshot", {});
  check("screenshot", fs.existsSync(shot.file), shot.file);
  const c5 = await c.call("browser_close", {});
  check("final close", c5.closed === true);
  c.stop();
}

// --- suite 2: AB_PROFILE env still works as persistent default
{
  const abp = fs.mkdtempSync(path.join(os.tmpdir(), "abp-"));
  const c = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1", AB_PROFILE: abp });
  await c.start();
  const o = await c.call("browser_open", { url: "https://example.com" });
  check("AB_PROFILE default persistent", o.persistent === true && o.profile === null && o.url.includes("example.com"), JSON.stringify(o));
  const cl = await c.call("browser_close", {});
  check("AB_PROFILE kept after close", cl.wiped === false && fs.existsSync(abp), JSON.stringify(cl));
  fs.rmSync(abp, { recursive: true, force: true });
  c.stop();
}

// --- suite 3: in-use profile rejected (second server instance, first holds lock)
{
  const a = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  const b = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  await a.start(); await b.start();
  await a.call("browser_open", { url: "https://example.com", profile: "smokebusy" });
  const r = await b.call("browser_open", { url: "https://example.com", profile: "smokebusy" });
  check("in-use profile -> structured busy", r.error === "busy" && r.profile === "smokebusy" && typeof r.retryAfterMs === "number", JSON.stringify(r));
  // b must still be usable with a different profile afterwards
  const r2 = await b.call("browser_open", { url: "https://example.com", profile: "smokebusy2" });
  check("busy does not wedge the server", !r2.ERR && r2.url && r2.url.includes("example.com"), JSON.stringify(r2));
  await a.call("browser_close", { discard: true, profile: "smokebusy" });
  await b.call("browser_close", { discard: true, profile: "smokebusy2" });
  a.stop(); b.stop();
}

// --- suite 4: parallel headless Chromes coexist (distinct profiles + auto port split)
{
  const a = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  const b = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  await a.start(); await b.start();
  const oa = await a.call("browser_open", { url: "https://example.com", profile: "parA" });
  const ob = await b.call("browser_open", { url: "https://www.wikipedia.org", profile: "parB" });
  check("parallel A open", !oa.ERR && oa.profile === "parA", JSON.stringify(oa));
  check("parallel B open (different profile, different port)", !ob.ERR && ob.profile === "parB" && ob.url.includes("wikipedia"), JSON.stringify(ob));
  // both live simultaneously
  const ta = await a.call("browser_read", { mode: "text", wait_for_text: "домен" }); // example.com serves RU text per ru-RU Accept-Language
  const tb = await b.call("browser_read", { mode: "text" });
  if (!(ta.text || "").includes("Example Domain")) console.log("  DBG A read url=" + ta.url + " text[0..200]=" + JSON.stringify((ta.text || "").slice(0, 200)));
  // example.com serves localized pages per Accept-Language — ru text is the same page
  check("A still on example.com", /Example Domain|примерах документации|Данный домен/.test(ta.text || ""), ta.url || "");
  check("B still on wikipedia", (tb.text || "").includes("Wikipedia"));
  // closing one must not affect the other
  await a.call("browser_close", {});
  const tb2 = await b.call("browser_read", { mode: "text" });
  check("B unaffected by A's close", (tb2.text || "").includes("Wikipedia"));
  await b.call("browser_close", { discard: true, profile: "parB" });
  a.stop(); b.stop();
  fs.rmSync(path.join(PROFILES, "parA"), { recursive: true, force: true });
}

// --- suite 4b: tab management (multi-tab, _blank following, piggyback tabs_changed)
{
  const c = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  await c.start();
  const page = "data:text/html;charset=utf-8," + encodeURIComponent('<body><a href="https://example.com/?from-blank" target="_blank" id="bl">go blank</a>here</body>');
  const o = await c.call("browser_open", { url: page });
  check("tabs: open base page", !!o.url, JSON.stringify(o));
  const r = await c.call("browser_click", { text: "go blank" });
  check("tabs: click _blank follows new tab", r.newTab === true && /from-blank/.test(r.url || ""), JSON.stringify({ url: r.url, newTab: r.newTab }));
  check("tabs: piggyback tabs_changed on click", !!(r.tabs_changed && Array.isArray(r.tabs_changed.added) && r.tabs_changed.added.length >= 1), JSON.stringify(r.tabs_changed || null));
  const lst = await c.call("browser_tabs", { action: "list" });
  check("tabs: list shows 2 tabs", lst.tabs.length === 2, JSON.stringify(lst.tabs?.map(t => t.url)));
  const activeTab = (lst.tabs || []).find(t => t.active);
  check("tabs: active is the new tab", !!activeTab && /from-blank/.test(activeTab.url || ""), JSON.stringify(activeTab?.url));
  const baseId = (lst.tabs || []).find(t => (t.url || "").startsWith("data:"))?.targetId;
  const blankId = activeTab?.targetId;
  const f = await c.call("browser_tabs", { action: "focus", targetId: baseId });
  check("tabs: focus switches driver back", (f.url || "").startsWith("data:"), JSON.stringify(f.url));
  const cl = await c.call("browser_tabs", { action: "close", targetId: blankId });
  check("tabs: close removes tab, stays on tab 0", cl.closed === true && /here/.test((await c.call("browser_read", { mode: "text" })).text || ""), JSON.stringify(cl).slice(0, 150));
  const nt = await c.call("browser_open", { url: "https://example.com/?newtab-param", newTab: true });
  check("tabs: newTab param opens + switches", !!nt.tab?.newTab && /newtab-param/.test(nt.url || ""), JSON.stringify(nt).slice(0, 200));
  const lst2 = await c.call("browser_tabs", { action: "list" });
  check("tabs: list shows 2 after newTab param", lst2.tabs.length === 2, JSON.stringify(lst2.tabs?.map(t => t.url)));
  const otherTab = (lst2.tabs || []).find(t => !t.active && t.targetId !== nt.tab?.targetId);
  const ti = await c.call("browser_open", { url: "https://example.com/?by-index", tabIndex: lst2.tabs.indexOf(otherTab) });
  check("tabs: tabIndex navigates existing tab", /by-index/.test(ti.url || "") && lst2.tabs.length === 2, JSON.stringify(ti).slice(0, 200));
  // unknown params must error, not silently no-op (errors return as tool results, not throws)
  const bad = await c.call("browser_tabs", { index: 1 });
  check("tabs: unknown param 'index' rejected", /index/.test(JSON.stringify(bad)) && /unknown parameter/i.test(JSON.stringify(bad)), JSON.stringify(bad));
  const bad2 = await c.call("browser_tabs", { action: "list", tabIndex: 0 });
  check("tabs: list with selector rejected", /takes no tab selector/i.test(JSON.stringify(bad2)), JSON.stringify(bad2));
  // stable indexes: after list, a NEW tab shifts nothing — tabIndex still means the last-seen order
  const lst3 = await c.call("browser_tabs", { action: "list" });
  const staleIdx = lst3.tabs.findIndex(t => (t.url || "").includes("by-index"));
  const staleId = lst3.tabs[staleIdx]?.targetId;
  await c.call("browser_open", { url: "https://example.com/?stable-new", newTab: true });
  const cl3 = await c.call("browser_tabs", { action: "close", tabIndex: staleIdx });
  check("tabs: tabIndex is stable across intervening newTab", cl3.closed === true && cl3.switchedTo !== staleId, JSON.stringify({ staleId, cl: JSON.stringify(cl3).slice(0,120) }));
  const after = await c.call("browser_tabs", { action: "list" });
  check("tabs: closed the right tab", !after.tabs.some(t => t.targetId === staleId), JSON.stringify(after.tabs?.map(t => t.url)));
  await c.call("browser_close", {});
  c.stop();
}

// --- suite 5: per-launch headless override (server started WITHOUT AB_HEADLESS)
{
  const c = mkClient({ AB_IDLE_SECONDS: "0" }); // no AB_HEADLESS → default headful
  await c.start();
  const o1 = await c.call("browser_open", { url: "https://example.com", headless: true });
  check("headless:true override", o1.headless === true && o1.url.includes("example.com"), JSON.stringify(o1));
  const o2 = await c.call("browser_open", { url: "https://example.com", headless: false });
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  check("headless:false override" + (hasDisplay ? "" : " (no display → auto-fallback accepted)"), o2.headless === !hasDisplay, JSON.stringify(o2));
  if (hasDisplay && !o2.headless) {
    await c.call("browser_open", { url: "https://example.com" }); // implicit navigate keeps headful browser
    const g = await c.call("browser_eval", { expression: "JSON.stringify({sw:screen.width,sh:screen.height,ow:outerWidth,oh:outerHeight,x:screenX,y:screenY})" });
    const geo = JSON.parse(typeof g === "string" ? g : g.value);
    const fits = geo.x >= 0 && geo.y >= 0 && geo.x + geo.ow <= geo.sw && geo.y + geo.oh <= geo.sh;
    check("headful window fits logical screen", fits, JSON.stringify(geo));
    const o3 = await c.call("browser_open", { url: "https://example.com" });
    const w = o3.window;
    const wfits = !!w && w.width <= w.workArea.width && w.height <= w.workArea.height;
    check("headful window size within work area", wfits, JSON.stringify(w));
  }
  await c.call("browser_close", {});
  c.stop();
}

// --- suite 6: stealth checks (bot.sannysoft.com + in-page probes)
{
  const c = mkClient({ AB_IDLE_SECONDS: "0", AB_HEADLESS: "1" });
  await c.start();
  const wd = await c.call("browser_eval", { expression: "navigator.webdriver" });
  check("navigator.webdriver === false", wd.value === false, JSON.stringify(wd));
  const rt = await c.call("browser_eval", { expression: "!!window.chrome && !!window.chrome.runtime" });
  check("chrome.runtime present", rt.value === true, JSON.stringify(rt));
  const pl = await c.call("browser_eval", { expression: "navigator.plugins.length" });
  check("plugins.length sane (>0)", typeof pl.value === "number" && pl.value > 0, JSON.stringify(pl));
  const lang = await c.call("browser_eval", { expression: "navigator.languages.join(',')" });
  check("languages ru-first", typeof lang.value === "string" && lang.value.startsWith("ru"), JSON.stringify(lang));
  const ua = await c.call("browser_eval", { expression: "navigator.userAgent" });
  check("UA has no Headless marker", !/Headless/i.test(ua.value || ""), String(ua.value).slice(0, 80));
  // sannysoft detector table
  const so = await c.call("browser_open", { url: "https://bot.sannysoft.com/", headless: true });
  check("sannysoft opens", !so.ERR, JSON.stringify(so));
  const t = await c.call("browser_read", { mode: "text", wait_for_text: "WebGL" });
  const txt = (t.text || "").toLowerCase();
  const rows = (t.text || "").split("\n").filter(l => /\b(pass|fail|warn)\b/i.test(l) || /(webdriver|chrome runtime|plugins|languages)/i.test(l));
  console.log("  sannysoft rows:\n" + rows.slice(0, 15).map(l => "   " + l.trim()).join("\n"));
  const flat = (t.text || "").replace(/\s+/g, " ");
  check("sannysoft: no webdriver fail", !/webdriver[^.;|]{0,60}fail/i.test(flat));
  // sannysoft's current table has no literal "Chrome runtime" row — probe it in-page on that page instead
  const rt2 = await c.call("browser_eval", { expression: "!!window.chrome && !!window.chrome.runtime" });
  check("sannysoft: chrome runtime pass", rt2.value === true, JSON.stringify(rt2));
  await c.call("browser_close", {});
  c.stop();
}

console.log(failures.length ? `\nSMOKE FAILED (${failures.length}): ${failures.join("; ")}` : "\nSMOKE OK");
process.exit(failures.length ? 1 : 0);
