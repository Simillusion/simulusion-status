// Builds status.simulusion.co from Upptime's data in this repository and its
// GitHub issues (incidents and scheduled maintenance), following the design
// handoff: an overall banner, each part's daily uptime bars, a legend,
// incidents with their updates, maintenance, Get updates (RSS) and a note on
// how checks run. No dependencies: Node 20+.
//
//   GITHUB_REPOSITORY=Simillusion/simulusion-status GITHUB_TOKEN=... node status-site/build.mjs
//
// Incidents are issues labelled `incident` (written by us) or `status`
// (opened by Upptime when a check fails). Labels name the parts it affects
// (their slugs) and how bad it is (`outage`, else degraded). Each comment is an
// update; start it with Investigating, Identified, Monitoring or Resolved.
// Maintenance is an issue labelled `maintenance` whose body holds
// <!-- start: 2026-12-01T02:00:00Z --> and <!-- end: 2026-12-01T02:30:00Z -->.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "dist");
const SITE = "https://status.simulusion.co";
const REPO = process.env.GITHUB_REPOSITORY || "Simillusion/simulusion-status";
const TOKEN = process.env.GITHUB_TOKEN || "";
const DAYS = 90;
const DAY_MS = 86_400_000;
// A day with at least this many minutes down is an outage; fewer, degraded.
const OUTAGE_MINUTES = 30;
const PAST_DAYS = 30;

const parts = JSON.parse(readFileSync(join(HERE, "parts.json"), "utf8"));
const summary = existsSync(join(ROOT, "history/summary.json"))
  ? JSON.parse(readFileSync(join(ROOT, "history/summary.json"), "utf8"))
  : [];
const now = new Date();

// ------------------------------------------------------------------ helpers

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isoDay = (d) => d.toISOString().slice(0, 10);
const dayLabel = (d) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeLabel = (d) =>
  d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) +
  " UTC";
const minutes = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} minute${n === 1 ? "" : "s"}`);

/** Markdown to plain text for incident updates: links, bold, code, Upptime's commit links. */
function plain(md) {
  return String(md ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/In \[`[0-9a-f]+`\]\([^)]*\),\s*/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function startTime(slug) {
  const file = join(ROOT, "history", `${slug}.yml`);
  if (!existsSync(file)) return null;
  const m = readFileSync(file, "utf8").match(/^startTime:\s*(\S+)/m);
  return m ? new Date(m[1]) : null;
}

async function github(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "simulusion-status" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ incidents

const KINDS = ["investigating", "identified", "monitoring", "resolved", "update"];

function updateOf(text, at, auto) {
  const body = plain(text);
  const m = body.match(/^(investigating|identified|monitoring|resolved|update)\b[\s:.-]*/i);
  let kind = m ? m[1].toLowerCase() : auto ? "investigating" : "update";
  // Upptime's own comment when a check passes again.
  if (/is back up/i.test(body)) kind = "resolved";
  return { kind, text: m ? body.slice(m[0].length) : body, at };
}

async function loadIssues() {
  let issues = [];
  try {
    issues = (await github("/issues?state=all&per_page=100&sort=created&direction=desc")).filter((i) => !i.pull_request);
  } catch (err) {
    console.warn(`Incidents left out: ${err.message}`);
    return { incidents: [], maintenance: [] };
  }
  const slugs = new Set(parts.map((p) => p.slug));
  const incidents = [];
  const maintenance = [];
  for (const issue of issues) {
    const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
    const affected = labels.filter((l) => slugs.has(l));
    if (labels.includes("maintenance")) {
      const start = issue.body?.match(/<!--\s*start:\s*(\S+)\s*-->/);
      const end = issue.body?.match(/<!--\s*end:\s*(\S+)\s*-->/);
      if (!start || !end) continue;
      maintenance.push({
        id: issue.number,
        title: issue.title,
        text: plain(issue.body),
        start: new Date(start[1]),
        end: new Date(end[1]),
        parts: affected,
      });
      continue;
    }
    const auto = labels.includes("status");
    if (!auto && !labels.includes("incident")) continue;
    const opened = new Date(issue.created_at);
    if (issue.state === "closed" && now - new Date(issue.closed_at) > PAST_DAYS * DAY_MS) continue;
    let comments = [];
    if (issue.comments > 0) {
      try {
        comments = await github(`/issues/${issue.number}/comments?per_page=100`);
      } catch (err) {
        console.warn(`Updates of #${issue.number} left out: ${err.message}`);
      }
    }
    const updates = [updateOf(issue.body || issue.title, opened, auto)];
    for (const c of comments) updates.push(updateOf(c.body, new Date(c.created_at), auto));
    if (issue.state === "closed" && updates.at(-1).kind !== "resolved") {
      updates.push({ kind: "resolved", text: "This incident has been resolved.", at: new Date(issue.closed_at) });
    }
    incidents.push({
      id: issue.number,
      title: plain(issue.title).replace(/^[^\w]+/, ""),
      open: issue.state === "open",
      severity: auto || labels.includes("outage") ? "outage" : "degraded",
      parts: affected,
      opened,
      closed: issue.closed_at ? new Date(issue.closed_at) : null,
      updates: updates.sort((a, b) => b.at - a.at),
    });
  }
  return { incidents, maintenance };
}

// ------------------------------------------------------------------ parts

function partState(part, open, active) {
  const live = summary.find((s) => s.slug === part.slug);
  const mine = open.filter((i) => i.parts.includes(part.slug));
  if (mine.some((i) => i.updates[0]?.kind === "monitoring")) return "monitoring";
  if (live?.status === "down" || mine.some((i) => i.severity === "outage")) return "outage";
  if (live?.status === "degraded" || mine.length) return "degraded";
  if (active.some((m) => m.parts.includes(part.slug))) return "maintenance";
  return live ? "operational" : "nodata";
}

function days(part, incidents) {
  const live = summary.find((s) => s.slug === part.slug);
  const down = live?.dailyMinutesDown || {};
  const started = startTime(part.slug);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today - i * DAY_MS);
    const key = isoDay(d);
    const mins = Number(down[key] || 0);
    const linked = incidents.find(
      (inc) => inc.parts.includes(part.slug) && isoDay(inc.opened) <= key && (!inc.closed || isoDay(inc.closed) >= key),
    );
    let state = "up";
    if (!live || !started || d.getTime() + DAY_MS <= started.getTime()) state = "none";
    else if (mins >= OUTAGE_MINUTES || (linked && linked.severity === "outage" && mins > 0)) state = "outage";
    else if (mins > 0 || linked) state = "degraded";
    out.push({ key, label: dayLabel(d), state, mins, incident: linked?.id ?? null, incidentTitle: linked?.title ?? null });
  }
  return out;
}

function uptime(dayList) {
  const counted = dayList.filter((d) => d.state !== "none");
  if (!counted.length) return null;
  const downMins = counted.reduce((n, d) => n + d.mins, 0);
  return (100 * (1 - downMins / (counted.length * 1440))).toFixed(2);
}

// ------------------------------------------------------------------ HTML

const BADGE = {
  operational: ["Operational", "success"],
  degraded: ["Degraded", "warning"],
  monitoring: ["Monitoring", "warning hollow"],
  outage: ["Outage", "error"],
  maintenance: ["Maintenance", "info"],
  nodata: ["No data yet", "muted"],
  resolved: ["Resolved", "success"],
};
const badge = (state) => {
  const [text, tone] = BADGE[state];
  return `<span class="badge ${tone}"><span class="dot" aria-hidden="true"></span>${text}</span>`;
};
const KIND_LABEL = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved", update: "Update" };
const MARK = `<svg class="mark" viewBox="0 0 178.23 240" aria-hidden="true"><path d="M20.68 131.52C32.19 131.15 41.93 139.96 42.69 151.46L42.73 151.92C43.47 161.65 47.48 174.93 56.89 184.06C64.53 191.48 77.45 196.82 89.9 197.27C101.41 197.7 110.51 207.16 110.48 218.68C110.46 230.2 101.31 239.62 89.8 239.99C78.29 240.36 68.56 231.54 67.79 220.05C67.15 210.43 63.28 197.15 54.04 187.88L53.6 187.45C45.95 180.03 33.03 174.69 20.58 174.23C9.08 173.81 -0.03 164.34 0 152.83C0.03 141.31 9.17 131.89 20.68 131.52Z"/><path d="M20.68 65.76C32.19 65.4 41.93 74.21 42.69 85.7L42.73 86.16C43.47 95.89 47.48 109.17 56.89 118.31C64.53 125.73 77.45 131.07 89.9 131.52C101.41 131.94 110.51 141.41 110.48 152.93C110.46 164.44 101.31 173.86 89.8 174.24C78.29 174.6 68.56 165.79 67.79 154.3C67.15 144.68 63.28 131.39 54.04 122.13L53.6 121.69C45.95 114.27 33.03 108.93 20.58 108.48C9.08 108.05 -0.03 98.59 0 87.07C0.03 75.56 9.17 66.14 20.68 65.76Z"/><path d="M88.43 65.76C99.94 65.4 109.67 74.21 110.44 85.7L110.47 86.16C111.22 95.89 115.22 109.17 124.63 118.31C132.28 125.73 145.2 131.07 157.65 131.52C169.15 131.94 178.26 141.41 178.23 152.93C178.2 164.44 169.06 173.86 157.55 174.24C146.04 174.6 136.3 165.79 135.54 154.3C134.9 144.68 131.02 131.39 121.79 122.13L121.34 121.69C113.7 114.27 100.78 108.93 88.33 108.48C76.82 108.05 67.72 98.59 67.75 87.07C67.77 75.56 76.92 66.14 88.43 65.76Z"/><path d="M88.43 0.01C99.94 -0.36 109.67 8.46 110.44 19.95L110.47 20.41C111.22 30.14 115.22 43.42 124.63 52.55C132.28 59.97 145.2 65.31 157.65 65.77C169.15 66.19 178.26 75.66 178.23 87.17C178.2 98.69 169.06 108.11 157.55 108.48C146.04 108.85 136.3 100.04 135.54 88.54C134.9 78.93 131.02 65.64 121.79 56.38L121.34 55.94C113.7 48.52 100.78 43.18 88.33 42.73C76.82 42.3 67.72 32.84 67.75 21.32C67.77 9.8 76.92 0.38 88.43 0.01Z"/></svg>`;

function incidentHtml(inc, nameOf) {
  const affected = inc.parts.map(nameOf).join(", ");
  const updates = inc.updates
    .map(
      (u) => `<li class="update"><span class="kind">${KIND_LABEL[u.kind]}</span><p>${esc(u.text)}</p><time datetime="${u.at.toISOString()}">${esc(timeLabel(u.at))}</time></li>`,
    )
    .join("");
  return `<article class="incident" id="incident-${inc.id}">
  <header><h3>${esc(inc.title)}</h3>${badge(inc.open ? (inc.updates[0]?.kind === "monitoring" ? "monitoring" : inc.severity) : "resolved")}</header>
  ${affected ? `<p class="affects">Affects ${esc(affected)}</p>` : ""}
  <ol class="updates">${updates}</ol>
</article>`;
}

function render({ incidents, maintenance }) {
  const nameOf = (slug) => parts.find((p) => p.slug === slug)?.name ?? slug;
  const open = incidents.filter((i) => i.open);
  const past = incidents.filter((i) => !i.open).sort((a, b) => b.opened - a.opened);
  const active = maintenance.filter((m) => m.start <= now && m.end > now);
  const upcoming = maintenance.filter((m) => m.start > now).sort((a, b) => a.start - b.start);
  const rows = parts.map((p) => {
    const list = days(p, incidents);
    return { ...p, state: partState(p, open, active), days: list, uptime: uptime(list) };
  });

  // Overall banner.
  const outages = rows.filter((r) => r.state === "outage");
  const degraded = rows.filter((r) => r.state === "degraded" || r.state === "monitoring");
  let banner;
  if (outages.length) {
    const names = outages.map((r) => r.name);
    const since = open.filter((i) => i.severity === "outage").map((i) => i.opened).sort((a, b) => a - b)[0];
    banner = `<section class="banner error" role="alert"><h2>${esc(names.length === 1 ? `${names[0]} ${/s$/.test(names[0]) ? "are" : "is"} down` : `${names.length} parts are down`)}</h2><p>${since ? `Since ${esc(timeLabel(since))}. ` : ""}${rows.filter((r) => r.state === "operational").length} of ${rows.length} parts are working. We post updates below as we learn more.</p></section>`;
  } else if (degraded.length) {
    banner = `<section class="banner warning" role="status"><h2>${esc(degraded.map((r) => r.name).join(", "))} ${degraded.length === 1 ? "is" : "are"} degraded</h2><p>Everything else is working. Updates are below.</p></section>`;
  } else {
    banner = `<section class="banner success" role="status"><h2>All systems operational</h2><p>Checked ${esc(timeLabel(now))}.</p></section>`;
  }

  const maint = [...active, ...upcoming]
    .map(
      (m) => `<section class="maintenance"><div><h3>${esc(m.title)}</h3><p class="when">${m.start <= now ? "In progress" : "Scheduled"} · ${esc(timeLabel(m.start))} to ${esc(timeLabel(m.end))}</p>${m.text ? `<p>${esc(m.text)}</p>` : ""}${m.parts.length ? `<p class="affects">Affects ${esc(m.parts.map(nameOf).join(", "))}</p>` : ""}</div>${badge("maintenance")}</section>`,
    )
    .join("");

  const partRows = rows
    .map((r) => {
      const bars = r.days
        .map((d) => {
          const tip =
            d.state === "none"
              ? `${d.label} · No data`
              : d.state === "up"
                ? `${d.label} · No downtime`
                : `${d.label} · ${d.state === "outage" ? "Down" : "Degraded"}${d.mins ? ` for ${minutes(d.mins)}` : ""}`;
          const attrs = `class="day ${d.state}" data-tip="${esc(tip)}"${d.incident ? ` data-incident="${d.incident}" data-note="${esc(d.incidentTitle)}"` : ""}`;
          return d.incident
            ? `<a href="#incident-${d.incident}" ${attrs} aria-label="${esc(tip)}"></a>`
            : `<span ${attrs} tabindex="0" aria-label="${esc(tip)}"></span>`;
        })
        .join("");
      return `<li class="part" id="${esc(r.slug)}">
  <div class="part-head"><div><h3>${esc(r.name)}</h3><p>${esc(r.about)}</p></div>${badge(r.state)}</div>
  <div class="bars" role="img" aria-label="${esc(r.name)}: daily uptime">${bars}</div>
  <div class="bar-foot"><span class="span-label"></span><span>${r.uptime === null ? "No data yet" : `${r.uptime}% uptime`}</span><span>Today</span></div>
</li>`;
    })
    .join("\n");

  const pastHtml = past.length
    ? past.map((i) => incidentHtml(i, nameOf)).join("\n")
    : `<p class="empty">No incidents in the past ${PAST_DAYS} days.</p>`;
  const partOptions = parts.map((p) => `<label><input type="checkbox" checked disabled> ${esc(p.name)}</label>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulusion status</title>
<meta name="description" content="Live status of the Simulusion website and platform.">
<link rel="alternate" type="application/rss+xml" title="Simulusion status" href="/feed.xml">
<link rel="icon" href="/mark.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="https://simulusion.co">${MARK}<span>Simulusion</span></a>
  <button type="button" class="button primary" data-open="updates">Get updates</button>
</header>
<main>
  ${banner}
  ${open.length ? `<section aria-labelledby="now"><h2 id="now" class="section">Incidents in progress</h2>${open.map((i) => incidentHtml(i, nameOf)).join("\n")}</section>` : ""}
  ${maint}
  <section aria-labelledby="parts">
    <div class="section-head"><h2 id="parts" class="section">Parts of the platform</h2>
      <ul class="legend"><li><span class="day up"></span>Up</li><li><span class="day degraded"></span>Degraded</li><li><span class="day outage"></span>Outage</li><li><span class="day none"></span>No data</li></ul>
    </div>
    <ul class="parts">${partRows}</ul>
  </section>
  <section aria-labelledby="past"><h2 id="past" class="section">Past incidents</h2>${pastHtml}</section>
  <section class="note" aria-labelledby="how"><h2 id="how" class="section">How we check</h2>
    <p>Each part is checked every 5 minutes from outside our servers, by <a href="https://github.com/${REPO}">an open monitor on GitHub</a>. A day shows as degraded when a part was down for under ${OUTAGE_MINUTES} minutes, and as an outage from ${OUTAGE_MINUTES} minutes. Times are in UTC.</p>
  </section>
</main>
<footer class="foot">
  <span>© ${now.getUTCFullYear()} Simulusion</span>
  <nav><a href="https://simulusion.co">Website</a><a href="https://simulusion.co/privacy">Privacy</a><a href="https://simulusion.co/terms">Terms</a><a href="/feed.xml">RSS</a></nav>
</footer>

<dialog id="updates" aria-labelledby="updates-title">
  <form method="dialog">
    <h2 id="updates-title">Get updates</h2>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="true" data-tab="email">Email</button>
      <button type="button" role="tab" aria-selected="false" data-tab="rss">RSS</button>
      <button type="button" role="tab" aria-selected="false" data-tab="slack">Slack</button>
    </div>
    <div class="tab" data-panel="email">
      <label class="field">Email<input type="email" placeholder="you@lab.org" disabled></label>
      <fieldset disabled><legend>Only tell me about some parts</legend><div class="checks">${partOptions}</div></fieldset>
      <p class="hint">Email updates open soon. Until then, follow the RSS feed or add it to Slack.</p>
    </div>
    <div class="tab" data-panel="rss" hidden>
      <p>Every incident and its updates, and scheduled maintenance.</p>
      <div class="copy"><code>${SITE}/feed.xml</code><button type="button" class="button" data-copy="${SITE}/feed.xml">Copy</button></div>
    </div>
    <div class="tab" data-panel="slack" hidden>
      <p>In any Slack channel, send:</p>
      <div class="copy"><code>/feed subscribe ${SITE}/feed.xml</code><button type="button" class="button" data-copy="/feed subscribe ${SITE}/feed.xml">Copy</button></div>
      <p class="hint">Slack's RSS app then posts each update in that channel.</p>
    </div>
    <p class="fine">We only send incidents and maintenance. You can unsubscribe in one click.</p>
    <div class="actions"><button class="button" value="close">Close</button></div>
  </form>
</dialog>
<div class="tip" role="tooltip" hidden></div>
<div class="toast" role="status" hidden></div>
<script src="/app.js" defer></script>
</body>
</html>
`;
}

function feed({ incidents, maintenance }) {
  const items = [
    ...incidents.map((i) => ({
      title: `${i.open ? "" : "Resolved: "}${i.title}`,
      link: `${SITE}/#incident-${i.id}`,
      guid: `incident-${i.id}-${i.updates.length}`,
      date: i.updates[0].at,
      text: i.updates.map((u) => `${KIND_LABEL[u.kind]}: ${u.text}`).join("\n\n"),
    })),
    ...maintenance.map((m) => ({
      title: `Scheduled maintenance: ${m.title}`,
      link: SITE,
      guid: `maintenance-${m.id}`,
      date: m.start,
      text: `${timeLabel(m.start)} to ${timeLabel(m.end)}. ${m.text}`,
    })),
  ]
    .sort((a, b) => b.date - a.date)
    .slice(0, 30);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Simulusion status</title><link>${SITE}</link>
<description>Incidents and maintenance for the Simulusion website and platform.</description>
<lastBuildDate>${now.toUTCString()}</lastBuildDate>
${items
  .map(
    (i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><guid isPermaLink="false">${esc(i.guid)}</guid><pubDate>${i.date.toUTCString()}</pubDate><description>${esc(i.text)}</description></item>`,
  )
  .join("\n")}
</channel></rss>
`;
}

const data = await loadIssues();
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), render(data));
writeFileSync(join(OUT, "feed.xml"), feed(data));
writeFileSync(join(OUT, "CNAME"), "status.simulusion.co\n");
for (const f of ["style.css", "app.js", "mark.svg"]) copyFileSync(join(HERE, f), join(OUT, f));
console.log(`Built ${parts.length} parts, ${data.incidents.length} incidents, ${data.maintenance.length} maintenance windows.`);
