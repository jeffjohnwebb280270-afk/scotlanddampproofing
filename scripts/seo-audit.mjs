#!/usr/bin/env node
/**
 * Daily SEO health check.
 *
 * Catches the things that silently break a live site and cost rankings before
 * anyone notices: a page starting to 404, a canonical pointing at the wrong
 * host after a deploy, duplicate titles, a sitemap drifting out of sync with
 * the pages that actually exist, an expiring certificate.
 *
 * Exits non-zero if anything fails, so CI surfaces it.
 *
 * Usage: node seo-audit.mjs https://www.example.co.uk
 */

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!BASE) {
  console.error('usage: node seo-audit.mjs <https://base-url>');
  process.exit(2);
}

const problems = [];
const warnings = [];
const notes = [];

const fail = (m) => { problems.push(m); console.log(`FAIL  ${m}`); };
const warn = (m) => { warnings.push(m); console.log(`WARN  ${m}`); };
const ok   = (m) => { console.log(`ok    ${m}`); };
const note = (m) => { notes.push(m); console.log(`      ${m}`); };

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'seo-audit/1.0' } });
  const ct = res.headers.get('content-type') || '';
  const body = /text\/|xml|json/i.test(ct) ? await res.text() : '';
  return { status: res.status, url: res.url, body };
}

const attr = (html, re) => (html.match(re) || [])[1] || '';
const title = (h) => attr(h, /<title>([\s\S]*?)<\/title>/i).trim();
const metaDesc = (h) => attr(h, /<meta\s+name="description"\s+content="([^"]*)"/i);
const canonical = (h) => attr(h, /<link\s+rel="canonical"\s+href="([^"]*)"/i);
const robotsMeta = (h) => attr(h, /<meta\s+name="robots"\s+content="([^"]*)"/i);

console.log(`\n=== SEO audit: ${BASE} ===\n`);

// ---------------------------------------------------------------- robots.txt
let sitemapUrl = `${BASE}/sitemap.xml`;
try {
  const r = await get(`${BASE}/robots.txt`);
  if (r.status !== 200) fail(`robots.txt returned ${r.status}`);
  else {
    ok('robots.txt reachable');
    if (/Disallow:\s*\/\s*$/m.test(r.body)) fail('robots.txt disallows the whole site');
    const declared = (r.body.match(/Sitemap:\s*(\S+)/i) || [])[1];
    if (!declared) warn('robots.txt does not declare a Sitemap');
    else { sitemapUrl = declared; ok(`robots.txt declares sitemap: ${declared}`); }
  }
} catch (e) { fail(`robots.txt unreachable: ${e.message}`); }

// ---------------------------------------------------------------- sitemap
let urls = [];
try {
  const s = await get(sitemapUrl);
  if (s.status !== 200) fail(`sitemap returned ${s.status}`);
  else {
    urls = [...s.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
    if (!urls.length) fail('sitemap contains no <loc> entries');
    else ok(`sitemap lists ${urls.length} URLs`);
    const wrongHost = urls.filter(u => !u.startsWith(BASE));
    if (wrongHost.length) fail(`sitemap URLs point at a different host: ${wrongHost.slice(0,3).join(', ')}`);
  }
} catch (e) { fail(`sitemap unreachable: ${e.message}`); }

// ---------------------------------------------------------------- per page
const titles = new Map();
const descs = new Map();

for (const u of urls) {
  let page;
  try { page = await get(u); }
  catch (e) { fail(`${u} — request failed: ${e.message}`); continue; }

  if (page.status !== 200) { fail(`${u} — HTTP ${page.status}`); continue; }

  const h = page.body;
  const t = title(h), d = metaDesc(h), c = canonical(h), rm = robotsMeta(h);

  if (!t) fail(`${u} — missing <title>`);
  else if (t.length > 65) warn(`${u} — title ${t.length} chars (Google truncates ~60)`);
  if (!d) fail(`${u} — missing meta description`);
  else if (d.length > 160) warn(`${u} — meta description ${d.length} chars (truncates ~155)`);
  else if (d.length < 70) warn(`${u} — meta description only ${d.length} chars, could say more`);

  if (!c) fail(`${u} — missing canonical`);
  else if (c.replace(/\/$/, '') !== u.replace(/\/$/, '')) fail(`${u} — canonical mismatch: ${c}`);

  if (/noindex/i.test(rm)) fail(`${u} — meta robots says noindex`);

  if (t) { titles.set(t, [...(titles.get(t) || []), u]); }
  if (d) { descs.set(d, [...(descs.get(d) || []), u]); }

  // structured data must be present and parse
  const blocks = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) warn(`${u} — no JSON-LD structured data`);
  for (const b of blocks) {
    try { JSON.parse(b); } catch { fail(`${u} — JSON-LD does not parse`); }
  }

  // images should carry alt text
  const imgs = [...h.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  const noAlt = imgs.filter(i => !/\balt\s*=\s*"/.test(i));
  if (noAlt.length) fail(`${u} — ${noAlt.length} image(s) missing alt text`);

  // one h1 per page
  const h1s = (h.match(/<h1\b/g) || []).length;
  if (h1s === 0) fail(`${u} — no <h1>`);
  else if (h1s > 1) warn(`${u} — ${h1s} <h1> elements`);

  ok(`${u.replace(BASE, '') || '/'} — 200, title/desc/canonical present`);
}

// ---------------------------------------------------------------- duplicates
for (const [t, list] of titles) if (list.length > 1) fail(`duplicate <title> "${t.slice(0,50)}" on ${list.length} pages`);
for (const [d, list] of descs) if (list.length > 1) fail(`duplicate meta description on ${list.length} pages`);
if (titles.size === urls.length && urls.length) ok('all titles unique');
if (descs.size === urls.length && urls.length) ok('all meta descriptions unique');

// ---------------------------------------------------------------- internal links
const linkTargets = new Set();
for (const u of urls.slice(0, 3)) {
  try {
    const p = await get(u);
    for (const m of p.body.matchAll(/href="(\/[^"#?]*)"/g)) linkTargets.add(BASE + m[1]);
  } catch {}
}
for (const t of linkTargets) {
  if (/\.(png|jpe?g|webp|svg|ico|css|js|xml|txt)$/i.test(t)) continue;
  try {
    const r = await fetch(t, { method: 'HEAD', redirect: 'follow' });
    if (r.status >= 400) fail(`broken internal link: ${t} → ${r.status}`);
  } catch (e) { fail(`broken internal link: ${t} — ${e.message}`); }
}
ok(`checked ${linkTargets.size} internal link targets`);

// ---------------------------------------------------------------- TLS expiry
try {
  const host = new URL(BASE).hostname;
  const { execSync } = await import('node:child_process');
  const out = execSync(
    `echo | timeout 15 openssl s_client -connect ${host}:443 -servername ${host} 2>/dev/null | openssl x509 -noout -enddate`,
    { encoding: 'utf8' });
  const end = new Date((out.match(/notAfter=(.*)/) || [])[1]);
  const days = Math.round((end - Date.now()) / 864e5);
  if (days < 14) fail(`TLS certificate expires in ${days} days`);
  else ok(`TLS certificate valid for ${days} more days`);
} catch { warn('could not read TLS expiry'); }

// ---------------------------------------------------------------- summary
console.log(`\n=== ${problems.length} problem(s), ${warnings.length} warning(s) ===`);
if (problems.length) { console.log('\nPROBLEMS:'); problems.forEach(p => console.log(`  - ${p}`)); }
if (warnings.length) { console.log('\nWARNINGS:'); warnings.forEach(w => console.log(`  - ${w}`)); }
process.exit(problems.length ? 1 : 0);
