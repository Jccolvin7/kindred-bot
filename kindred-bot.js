// ============================================================
// KINDRED DISCORD BOT — Supabase Edition
// Commands: /rate /profile /twin /recs /catalog /search
// Identity: Discord ID (no email needed)
// Database: Supabase (users, tastes, matches tables)
// ============================================================

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fetch from 'node-fetch';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

// Bundled fonts — registered explicitly rather than relying on generic
// CSS-style names like "sans-serif"/"serif"/"monospace". Minimal container
// environments (like Railway's slim Node image) often ship with zero
// system fonts installed at all; in that case @napi-rs/canvas silently
// renders blank/broken text instead of throwing a catchable error, which is
// exactly the "dark box with no visible content" failure this fixes.
// Font files live in /fonts alongside this script — DejaVu, a free,
// redistributable font family bundled directly with the bot so rendering
// never depends on what's installed on the host.
const FONTS_DIR = new URL('./fonts/', import.meta.url).pathname;
GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSans.ttf`, 'KindredSans');
GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSans-Bold.ttf`, 'KindredSans-Bold');
GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSerif.ttf`, 'KindredSerif');
GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSansMono.ttf`, 'KindredMono');

// ─── ENV VARS (set these in Railway) ────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const TMDB_API_KEY    = process.env.TMDB_API_KEY;
const RAWG_API_KEY    = process.env.RAWG_API_KEY;

// ─── SUPABASE HELPERS ────────────────────────────────────────

async function sbFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation,resolution=merge-duplicates' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function upsertUser(discordId, username) {
  // IMPORTANT: discord_id has NO unique constraint in the database, so a
  // PostgREST upsert (Prefer: resolution=merge-duplicates) cannot dedupe on
  // it — it silently degrades to a plain INSERT and creates a brand-new
  // users row on every single call. That meant each /rate spawned a fresh
  // duplicate account, ratings scattered across many rows, and the twin
  // gate could never reach 8. The robust fix that does NOT depend on a DB
  // constraint: look the user up first, and only insert if they're genuinely
  // new. This also fixes signup_completed being logged on every rate (the
  // old code returned created:true on every successful insert/merge).
  const existing = await getUserByDiscordId(discordId);
  if (existing) {
    return { user: existing, created: false };
  }
  const rows = await sbFetch('users', 'POST', {
    discord_id: discordId,
    username: username,
  });
  // Brand-new account — caller uses created:true to log signup_completed
  // exactly once, the first time this Discord user ever rates anything.
  return { user: rows[0], created: true };
}

async function saveRating(userId, category, itemName, rating) {
  // Re-rating the same title should UPDATE the existing row, not insert a
  // second one. The web app's setRating already does this; the bot was
  // doing a blind insert every time, so a user who changed their mind on a
  // title ended up with duplicate tastes rows — inflating their /profile
  // list, their level/freshness counts, and their archetype volume buckets.
  // (Twin matching collapses duplicates via its category:item_name map, so
  // scores were unaffected, but the visible counts were wrong.)
  const existing = await sbFetch(
    `tastes?user_id=eq.${userId}&category=eq.${encodeURIComponent(category)}&item_name=eq.${encodeURIComponent(itemName)}&select=id&limit=1`
  );
  if (existing && existing.length > 0) {
    await sbFetch(`tastes?id=eq.${existing[0].id}`, 'PATCH', { rating });
    return;
  }
  await sbFetch('tastes', 'POST', {
    user_id: userId,
    category,
    item_name: itemName,
    rating,
  });
}

async function getUserRatings(userId) {
  return await sbFetch(`tastes?user_id=eq.${userId}&select=*`);
}

async function getAllRatings() {
  return await sbFetch('tastes?select=*');
}

async function getUserByDiscordId(discordId) {
  const rows = await sbFetch(`users?discord_id=eq.${discordId}&select=*`);
  return rows[0] || null;
}

// Minimal event logger for the consent feature specifically. The bot has
// no broader analytics logging today (only the web app does) — this is
// scoped narrowly to data_sharing_consent_given/changed rather than
// building out full bot-side analytics, which is a separate task.
async function logBotEvent(uid, eventType, detail) {
  try { await sbFetch('events', 'POST', { user_id: uid, event_type: eventType, detail: detail || null }); } catch (e) {}
}

// Same dedup semantics as the web app's logEventOnce — checks whether this
// event type has ever fired for this user before inserting, so something
// like first_match_unlocked only ever logs once per account regardless of
// how many times /twin gets run afterward.
async function logBotEventOnce(uid, eventType, detail) {
  try {
    const existing = await sbFetch(`events?user_id=eq.${uid}&event_type=eq.${eventType}&select=id&limit=1`);
    if (existing && existing.length > 0) return;
    await logBotEvent(uid, eventType, detail);
  } catch (e) {}
}

async function saveMatch(userId1, userId2, score) {
  await sbFetch('matches', 'POST', {
    user_id_1: userId1,
    user_id_2: userId2,
    match_score: score,
  });
}

// ─── LIVE CATALOG SEARCH ─────────────────────────────────────

async function searchFilm(query) {
  const [movieRes, tvRes] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`),
    fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`),
  ]);
  const movies = await movieRes.json();
  const tv = await tvRes.json();

  const results = [
    ...(movies.results || []).slice(0, 4).map(m => ({
      title: m.title,
      year: m.release_date ? m.release_date.slice(0, 4) : null,
      kind: 'Film',
    })),
    ...(tv.results || []).slice(0, 3).map(t => ({
      title: t.name,
      year: t.first_air_date ? t.first_air_date.slice(0, 4) : null,
      kind: 'TV',
    })),
  ];
  return results.slice(0, 6);
}

async function searchGames(query) {
  const res = await fetch(`https://api.rawg.io/api/games?key=${RAWG_API_KEY}&search=${encodeURIComponent(query)}&page_size=6`);
  const data = await res.json();
  return (data.results || []).slice(0, 6).map(g => ({
    title: g.name,
    year: g.released ? g.released.slice(0, 4) : null,
    kind: 'Game',
  }));
}

async function searchBooks(query) {
  const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=6`);
  const data = await res.json();
  return (data.docs || []).slice(0, 6).map(b => ({
    title: b.title,
    year: b.first_publish_year || null,
    kind: 'Book',
  }));
}

// ─── AFFILIATE LINKS ────────────────────────────────────────────
// Ported from the web app's buildAffiliateLink. The web app's version
// calls its own /api/search-books serverless route for the ISBN lookup —
// that's a relative URL that only resolves inside a browser already on
// kindredmatch.co, so it has no meaning from this Node process. Rather
// than add a fragile cross-service HTTP dependency on the web app's own
// deployment (breaks if its URL or auth rules ever change), this queries
// Open Library directly, same external API, same query shape as the
// corrected /api/search-books.js route uses.
const AMAZON_TAG = 'kindredmatch-20';
const BOOKSHOP_AFFILIATE_ID = '125337';

async function lookupISBN(title) {
  try {
    const res = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=5&fields=title,isbn`);
    const data = await res.json();
    const match = (data.docs || []).find(b => b.title?.toLowerCase() === title.toLowerCase()) || data.docs?.[0];
    return Array.isArray(match?.isbn) && match.isbn.length ? match.isbn[0] : null;
  } catch (e) {
    return null;
  }
}

async function buildAffiliateLink(category, title) {
  if (category === 'books') {
    const isbn = await lookupISBN(title);
    if (isbn) return `https://bookshop.org/a/${BOOKSHOP_AFFILIATE_ID}/${isbn}`;
    // No confident ISBN match — fall back to Amazon rather than a dead link.
  }
  return `https://www.amazon.com/s?k=${encodeURIComponent(title)}&tag=${AMAZON_TAG}`;
}

async function searchCatalog(category, query) {
  if (category === 'film') return searchFilm(query);
  if (category === 'games') return searchGames(query);
  if (category === 'books') return searchBooks(query);
  return [];
}

// ─── ARCHETYPE — 2-AXIS SYSTEM (PORTED FROM WEB APP) ──────────
// UPDATE: the original 3-axis spec (mood/category/behavior) had its mood
// axis dropped — it read as gimmicky/made-up. Now it's just category + a
// real, human-sounding behavior word: 8 categories x 8 behavior words = 64
// combinations. This is a direct port of the web app's updated buildArchetype
// logic, adapted to the bot's flat tastes-row shape instead of the web app's
// {film:{}, games:{}, books:{}} ratings object. Keeping both platforms on
// the exact same label format matters because Tier 3 of the recs engine
// ("trending among people who share your archetype") depends on it.

const CATEGORY_COLORS = {
  'Sci-Fi':'#8B5CF6', Horror:'#EF4444', 'Literary Fiction':'#F59E0B', 'Strategy Games':'#06B6D4',
  'Prestige Drama':'#A78BFA', Fantasy:'#10B981', Indie:'#FBBF24', Action:'#3B82F6',
};

const CATEGORY_KEYWORDS = {
  'Sci-Fi': ['interstellar','blade runner','dune','arrival','ex machina','inception','2001','contact','martian','foundation'],
  'Horror': ['ring','exorcist','hereditary','midsommar','conjuring','resident evil','silent hill','it follows'],
  'Literary Fiction': ['ishiguro','atwood','never let me go','beloved','the road','life of pi'],
  'Strategy Games': ['civilization','age of empires','xcom','crusader kings','total war','starcraft','frostpunk'],
  'Prestige Drama': ['succession','the wire','breaking bad','mad men','the sopranos'],
  'Fantasy': ['witcher','lord of the rings','name of the wind','game of thrones'],
  'Indie': ['hollow knight','celeste','stardew','undertale','hades','disco elysium'],
  'Action': ['dark souls','god of war','devil may cry','doom','red dead','elden ring'],
};

// AXIS 2 — behavior words, grouped into four buckets. Two near-synonyms
// per bucket; a seed-hash picks between them so two users in the same
// bucket don't necessarily land on the identical word.
const BEHAVIOR_BUCKETS = {
  fanatic:     ['Fanatic', 'Diehard'],
  connoisseur: ['Connoisseur', 'Snob'],
  aficionado:  ['Aficionado', 'Lover'],
  nerd:        ['Junkie', 'Nerd'],
};

function hashPick(seed, list) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % list.length;
  return list[Math.abs(hash) % list.length];
}

function pickCategoryAxis(ratings) {
  const allTitles = ratings.map(r => r.item_name.toLowerCase());
  const scores = {};
  Object.entries(CATEGORY_KEYWORDS).forEach(([cat, keywords]) => {
    scores[cat] = allTitles.filter(t => keywords.some(k => t.includes(k))).length;
  });
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return { category: best[0], matched: best[1] };
  const counts = {
    film: ratings.filter(r => r.category === 'film').length,
    games: ratings.filter(r => r.category === 'games').length,
    books: ratings.filter(r => r.category === 'books').length,
  };
  const domainFallback = { film: 'Prestige Drama', games: 'Action', books: 'Literary Fiction' };
  const topDomain = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return { category: domainFallback[topDomain], matched: 0 };
}

// Behavior is driven by volume/pattern WITHIN the dominant category
// specifically (not a global cross-domain comparison), per the updated
// spec. Casual mapping is fine to start — refine once there's real usage
// data to look at.
function pickBehaviorAxis(seed, category, ratings) {
  const keywords = CATEGORY_KEYWORDS[category] || [];
  const inCategory = ratings
    .filter(r => keywords.some(k => r.item_name.toLowerCase().includes(k)))
    .map(r => r.rating)
    .filter(Boolean);

  const count = inCategory.length;
  const avg = count ? inCategory.reduce((a, b) => a + b, 0) / count : 0;

  let bucket;
  if (count >= 8) bucket = 'fanatic';
  else if (count >= 4 && avg >= 4.3) bucket = 'connoisseur';
  else if (count >= 2) bucket = 'aficionado';
  else bucket = 'nerd';

  return hashPick(seed + category, BEHAVIOR_BUCKETS[bucket]);
}

// Returns { category, behavior, label, categoryColor } where label is the
// exact same "Category Behavior" string format the web app writes to
// users.archetype — this is what makes cross-platform Tier 3 matching work.
function buildArchetype(seed, ratings) {
  const { category } = pickCategoryAxis(ratings);
  const behavior = pickBehaviorAxis(seed, category, ratings);
  return {
    category, behavior, label: `${category} ${behavior}`,
    categoryColor: CATEGORY_COLORS[category] || '#8B5CF6',
  };
}

// Writes the computed archetype to users.archetype so it's available for
// Tier 3 of the recs engine (and consistent with the web app). Call this
// after /rate saves a new rating. Fire-and-forget — a failed write here
// shouldn't block the rating confirmation the user is waiting on.
async function saveArchetypeForUser(dbUserId, discordUsername) {
  try {
    const ratings = await getUserRatings(dbUserId);
    // Seed with the numeric DB user id, NOT the Discord username. The web app
    // seeds buildArchetype with the same users.id, so for a linked/merged
    // account both platforms feed the identical seed into the behavior-word
    // hash and therefore write the IDENTICAL users.archetype string. Seeding
    // with the username here would make the same user flip between e.g.
    // "Sci-Fi Fanatic" and "Sci-Fi Diehard" depending on which platform they
    // last rated on, fragmenting the Tier 3 archetype-match pool.
    const archetype = buildArchetype(dbUserId, ratings);
    await sbFetch(`users?id=eq.${dbUserId}`, 'PATCH', { archetype: archetype.label });
  } catch (e) { /* non-critical — Tier 3 just has one less data point this round */ }
}

// ─── PASSPORT, LEVELS, FRESHNESS ──────────────────────────────
// Mirrors the web app exactly so a Kindred identity feels the same on Discord.

const TWIN_UNLOCK_THRESHOLD = 8;

const LEVELS = [
  { min: 0,  label: 'New Arrival' },
  { min: 1,  label: 'Wanderer' },
  { min: 5,  label: 'Explorer' },
  { min: 15, label: 'Connoisseur' },
  { min: 30, label: 'Taste Master' },
];
function getExplorerLevel(totalRated) {
  let current = LEVELS[0];
  for (const l of LEVELS) { if (totalRated >= l.min) current = l; }
  return current.label;
}

// Lightweight placeholder for a future real decay system — no timestamps yet,
// just progress toward the next 5-rating milestone.
function getFreshness(totalRated) {
  if (totalRated === 0) return { pct: 0, remaining: 5 };
  const intoCurrentBand = totalRated % 5;
  if (intoCurrentBand === 0) return { pct: 100, remaining: 0 };
  return { pct: Math.round((intoCurrentBand / 5) * 100), remaining: 5 - intoCurrentBand };
}

// ─── SHAREABLE IMAGE CARDS (CANVAS) ────────────────────────────
// Discord has no browser/DOM, so this can't reuse html2canvas the way the
// web app does. @napi-rs/canvas draws directly to a bitmap in plain Node —
// same visual result (1080x1080, same colors/layout as the web app's share
// cards), just built by hand with canvas drawing calls instead of CSS.
// Returns a PNG Buffer ready to wrap in a Discord AttachmentBuilder.

const BG_DARK = '#080B16';
const BG_DEEP = '#150B2E';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT_MAIN = '#F1F5F9';
const TEXT_MUTED = '#94A3B8';
const TEXT_DIM = '#475569';
const PURPLE_HEX = '#8B5CF6';
const CYAN_HEX = '#06B6D4';

// Wraps text to a max width, drawing each line. Returns the y position
// after the last line, so callers can stack content below it.
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      line = word;
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, curY); curY += lineHeight; }
  return curY;
}

// Counts how many lines drawWrappedText would produce for the given text,
// without drawing anything — used to size a background box to fit before
// drawing it, since "why" text length varies a lot (1-3 shared titles of
// very different lengths) and a fixed box height either clips long text or
// leaves awkward empty space on short text.
function countWrappedLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines++;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines++;
  return lines;
}

function drawCardHeader(ctx) {
  ctx.fillStyle = TEXT_MAIN;
  ctx.font = '500 38px KindredSans-Bold';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Kind', 90, 100);
  const kindWidth = ctx.measureText('Kind').width;
  ctx.fillStyle = PURPLE_HEX;
  ctx.fillText('r', 90 + kindWidth, 100);
  const rWidth = ctx.measureText('r').width;
  ctx.fillStyle = TEXT_MAIN;
  ctx.fillText('ed', 90 + kindWidth + rWidth, 100);
}

function drawCardFooter(ctx) {
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(90, 988); ctx.lineTo(990, 988); ctx.stroke();

  ctx.fillStyle = TEXT_MUTED;
  ctx.font = '26px KindredSans';
  ctx.fillText('Find your taste twin at', 90, 1040);

  ctx.fillStyle = CYAN_HEX;
  ctx.font = '30px KindredMono';
  const label = 'kindredmatch.co';
  const w = ctx.measureText(label).width;
  ctx.fillText(label, 990 - w, 1042);
}

function renderPassportCardPNG({ archetype, level, total }) {
  const canvas = createCanvas(1080, 1080);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, BG_DARK);
  grad.addColorStop(1, BG_DEEP);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1080);

  drawCardHeader(ctx);

  // Level pill, top right
  ctx.font = '22px KindredMono';
  const pillText = level;
  const pillW = ctx.measureText(pillText).width + 56;
  ctx.fillStyle = 'rgba(139,92,246,0.18)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(990 - pillW, 64, pillW, 48, 24) : ctx.rect(990 - pillW, 64, pillW, 48);
  ctx.fill();
  ctx.strokeStyle = 'rgba(139,92,246,0.35)';
  ctx.stroke();
  ctx.fillStyle = '#C4B5D9';
  ctx.fillText(pillText, 990 - pillW + 28, 96);

  ctx.fillStyle = PURPLE_HEX;
  ctx.font = '24px KindredMono';
  ctx.fillText('TASTE PASSPORT', 90, 200);

  // Archetype line — category in its color, behavior in plain text
  ctx.font = '300 70px KindredSerif';
  let cursorX = 90, cursorY = 290;
  ctx.fillStyle = archetype.categoryColor;
  ctx.fillText(archetype.category, cursorX, cursorY);
  cursorX += ctx.measureText(archetype.category + ' ').width;
  ctx.fillStyle = TEXT_MAIN;
  // Behavior wraps to a new line if the combined text would overflow the card.
  if (cursorX + ctx.measureText(archetype.behavior).width > 990) {
    cursorY += 80;
    ctx.fillText(archetype.behavior, 90, cursorY);
  } else {
    ctx.fillText(archetype.behavior, cursorX, cursorY);
  }

  ctx.fillStyle = TEXT_MUTED;
  ctx.font = '30px KindredSans';
  ctx.fillText(`${total} items rated across film, games, and books`, 90, cursorY + 90);

  drawCardFooter(ctx);
  return canvas.toBuffer('image/png');
}

function renderTwinCardPNG({ overall, handle, why, shared }) {
  const canvas = createCanvas(1080, 1080);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, BG_DARK);
  grad.addColorStop(1, BG_DEEP);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1080, 1080);

  drawCardHeader(ctx);

  ctx.fillStyle = PURPLE_HEX;
  ctx.font = '24px KindredMono';
  ctx.fillText('TASTE TWIN MATCH', 90, 200);

  ctx.fillStyle = PURPLE_HEX;
  ctx.font = '700 160px KindredMono';
  ctx.fillText(`${overall}%`, 90, 380);
  const pctWidth = ctx.measureText(`${overall}%`).width;

  ctx.fillStyle = TEXT_MUTED;
  ctx.font = '34px KindredSans';
  ctx.fillText(`match with ${handle}`, 90 + pctWidth + 24, 380);

  let y = 460;
  if (why) {
    const whyFullText = `WHY YOU MATCHED - ${why}`;
    ctx.font = '28px KindredSans';
    const lineCount = countWrappedLines(ctx, whyFullText, 830);
    const lineHeight = 38;
    const boxH = (lineCount * lineHeight) + 56; // text height + top/bottom padding

    ctx.fillStyle = 'rgba(139,92,246,0.08)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(90, y, 900, boxH, 18) : ctx.rect(90, y, 900, boxH);
    ctx.fill();
    ctx.strokeStyle = 'rgba(139,92,246,0.2)';
    ctx.stroke();
    ctx.fillStyle = '#C4B5D9';
    ctx.font = '28px KindredSans';
    // NOTE: emoji glyphs aren't reliable in canvas-rendered text (no emoji
    // font bundled by default), so this uses a plain-text marker instead of
    // 💡 to avoid a broken/hollow-box character showing up in the image.
    drawWrappedText(ctx, whyFullText, 126, y + 46, 830, lineHeight);
    y += boxH + 48;
  }

  if (shared?.length) {
    ctx.fillStyle = TEXT_DIM;
    ctx.font = '22px KindredMono';
    ctx.fillText('YOU BOTH LOVED', 90, y);
    y += 50;
    let pillX = 90;
    ctx.font = '26px KindredSans';
    shared.slice(0, 4).forEach(title => {
      const w = ctx.measureText(title).width + 52;
      if (pillX + w > 990) { pillX = 90; y += 80; }
      ctx.fillStyle = 'rgba(139,92,246,0.12)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(pillX, y, w, 56, 28) : ctx.rect(pillX, y, w, 56);
      ctx.fill();
      ctx.strokeStyle = 'rgba(139,92,246,0.25)';
      ctx.stroke();
      ctx.fillStyle = '#C4B5D9';
      ctx.fillText(title, pillX + 26, y + 38);
      pillX += w + 14;
    });
  }

  drawCardFooter(ctx);
  return canvas.toBuffer('image/png');
}

// ─── RARITY WEIGHTING ────────────────────────────────────────
// Two people both loving a mainstream title (everyone's rated it) should count
// for very little. Two people both loving a niche title (almost nobody else has
// rated it) should count for a lot more. Weight runs from 0.3 (mainstream) up
// to 3 (rare). This mirrors the exact same logic used on the web app, so a
// match score feels the same whether someone uses Discord or the website.
//
// NOTE: this also fixes a pre-existing gap — matching previously keyed only on
// item_name (lowercased), with no category. That meant a book and a film
// sharing the same title would have been treated as the same item. Every
// matching key below is now "category:item_name" to match the web app exactly.

function computeRarityWeights(allRatings) {
  const raterSets = {};
  allRatings.forEach(r => {
    const key = `${r.category}:${r.item_name.toLowerCase()}`;
    if (!raterSets[key]) raterSets[key] = new Set();
    raterSets[key].add(r.user_id);
  });
  const totalUsers = new Set(allRatings.map(r => r.user_id)).size;
  const weights = {};
  Object.keys(raterSets).forEach(key => {
    const raterCount = raterSets[key].size;
    const raw = Math.log((totalUsers + 1) / (raterCount + 1)) + 0.3;
    weights[key] = Math.max(0.3, Math.min(3, raw));
  });
  return weights;
}

function buildWhyText(sharedTitles) {
  if (!sharedTitles || sharedTitles.length === 0) return null;
  if (sharedTitles.length === 1) return `Matched mostly on ${sharedTitles[0]}. Not many people have rated that one.`;
  const list = [...sharedTitles];
  const last = list.pop();
  return `Matched mostly on ${list.join(', ')} and ${last}. Rare picks that few others share.`;
}

// ─── TASTE TWIN MATCHING ─────────────────────────────────────

function computeMatchScore(myRatings, theirRatings, rarityWeights) {
  const myMap = {};
  myRatings.forEach(r => { myMap[`${r.category}:${r.item_name.toLowerCase()}`] = r.rating; });
  const theirMap = {};
  theirRatings.forEach(r => { theirMap[`${r.category}:${r.item_name.toLowerCase()}`] = r.rating; });

  const sharedKeys = Object.keys(myMap).filter(k => theirMap[k] !== undefined);
  if (sharedKeys.length === 0) return { score: 0, sharedKeys: [] };

  let totalWeighted = 0;
  let totalWeight = 0;
  sharedKeys.forEach(key => {
    const diff = Math.abs(myMap[key] - theirMap[key]);
    let pointScore;
    if (diff === 0) pointScore = 100;
    else if (diff === 1) pointScore = 70;
    else if (diff === 2) pointScore = 30;
    else pointScore = 0;
    const weight = (rarityWeights && rarityWeights[key]) || 1;
    totalWeighted += pointScore * weight;
    totalWeight += weight;
  });

  return { score: Math.round(totalWeighted / totalWeight), sharedKeys };
}

function findTwin(myUserId, myRatings, allRatings) {
  const rarityWeights = computeRarityWeights(allRatings);
  const byUser = {};
  allRatings.forEach(r => {
    if (r.user_id === myUserId) return;
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r);
  });

  let bestUserId = null;
  let bestScore = 0;

  Object.entries(byUser).forEach(([uid, theirRatings]) => {
    const { score } = computeMatchScore(myRatings, theirRatings, rarityWeights);
    if (score > bestScore) {
      bestScore = score;
      bestUserId = uid;
    }
  });

  return { bestUserId, bestScore, rarityWeights };
}

// Ranked version of findTwin — returns the top N twins instead of just the
// single best one. The recs engine's Tier 1/2 need a ranked list to pull
// candidate items from (the web app's equivalent is buildTwinGraph); /twin
// keeps using the single-best findTwin above since it only ever shows one.
function findTopTwins(myUserId, myRatings, allRatings, limit = 10) {
  const rarityWeights = computeRarityWeights(allRatings);
  const byUser = {};
  allRatings.forEach(r => {
    if (r.user_id === myUserId) return;
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r);
  });

  const candidates = Object.entries(byUser).map(([uid, ratings]) => {
    const { score } = computeMatchScore(myRatings, ratings, rarityWeights);
    return { userId: uid, score, ratings };
  }).filter(c => c.score > 0);

  candidates.sort((a, b) => b.score - a.score);
  return { topTwins: candidates.slice(0, limit), rarityWeights };
}

// ─── "YOUR TWIN CHANGED" NOTIFICATIONS — V1 ───────────────────
// ONE trigger only: did the person who just rated something 4-5★ turn out
// to be someone ELSE's #1 Taste Neighbor, on an item that other person
// hasn't rated yet? Score-shift and new-#1-twin triggers are deferred —
// they need a scheduled recompute job to diff against last-known state,
// which isn't worth building before there's real usage to tune it
// against. This is event-triggered (runs once, right after a rating is
// saved), not a poll, so it stays cheap at this stage. The bot can write
// directly (it already runs on the service-role key, unlike the web app,
// which has to go through a serverless endpoint for the same reason).
//
// Called fire-and-forget after /rate, same pattern as saveArchetypeForUser
// — a failed notification check should never block the rating confirmation
// the user is waiting on.
async function notifyTwinsOfNewRating(raterId, category, itemName, rating) {
  if (rating < 4) return;
  try {
    const allRatings = await getAllRatings();
    const rarityWeights = computeRarityWeights(allRatings);
    const meKey = String(raterId);

    // Only users who overlap with the rater at all are worth checking —
    // same narrowing the serverless endpoint uses, keeps this cheap rather
    // than recomputing every user's twin graph on every single rating.
    const overlapUserIds = new Set();
    allRatings.forEach(r => { if (String(r.user_id) !== meKey) overlapUserIds.add(r.user_id); });

    // Local #1-twin lookup that reuses the rarityWeights already computed
    // above, instead of calling findTwin per-candidate (which would
    // recompute computeRarityWeights(allRatings) — same result, every
    // single time — inside the loop).
    const byUser = {};
    allRatings.forEach(r => {
      if (!byUser[r.user_id]) byUser[r.user_id] = [];
      byUser[r.user_id].push(r);
    });

    for (const candidateId of overlapUserIds) {
      const candidateRatings = byUser[candidateId] || [];
      let bestUserId = null, bestScore = 0;
      Object.keys(byUser).forEach(otherUid => {
        if (otherUid === String(candidateId)) return;
        const { score } = computeMatchScore(candidateRatings, byUser[otherUid], rarityWeights);
        if (score > bestScore) { bestScore = score; bestUserId = otherUid; }
      });
      if (bestScore === 0 || bestUserId !== meKey) continue;

      const key = `${category}:${itemName.toLowerCase()}`;
      const alreadyRated = candidateRatings.some(r => `${r.category}:${r.item_name.toLowerCase()}` === key);
      if (alreadyRated) continue;

      // Dedup: same check-before-insert discipline as everywhere else in
      // this bot (logBotEventOnce, upsertUser, saveRating) rather than
      // relying on a DB constraint that doesn't exist.
      const existing = await sbFetch(
        `notifications?user_id=eq.${candidateId}&twin_user_id=eq.${raterId}&category=eq.${encodeURIComponent(category)}&item_name=eq.${encodeURIComponent(itemName)}&select=id&limit=1`
      );
      if (existing.length > 0) continue;

      await sbFetch('notifications', 'POST', {
        user_id: candidateId,
        twin_user_id: raterId,
        category,
        item_name: itemName,
        rating,
        source_id: null,
      });
    }
  } catch (e) { /* non-critical — worst case a notification is missed this round */ }
}

// ─── 5-TIER RECOMMENDATION ENGINE (BOT) ───────────────────────
// Same design as the web app: tiers fill top-down, each tier only runs if
// the one above didn't reach RECS_TARGET, AI is Tier 5 only — a clearly
// labeled last resort, never blended with the real-data tiers above it.
// This replaces the old approach (hand Claude the user's top-10 ratings and
// ask it to invent 6 titles from general knowledge).

const RECS_TARGET = 6;

// Tier 1 — items the user's top twins rated 4-5 stars that the user hasn't
// rated. Ranked by twin match score + rarity weight + how many different
// twins loved it.
function buildTwinBackedRecs(myUserId, myRatings, allRatings, limit = RECS_TARGET) {
  const { topTwins, rarityWeights } = findTopTwins(myUserId, myRatings, allRatings, 10);
  const mineKeys = new Set(myRatings.map(r => `${r.category}:${r.item_name.toLowerCase()}`));

  const itemMap = {};
  topTwins.forEach(twin => {
    twin.ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = `${r.category}:${r.item_name.toLowerCase()}`;
      if (mineKeys.has(key)) return;
      if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, twinScores: [] };
      itemMap[key].twinScores.push({ twinScore: twin.score, rarityWeight: rarityWeights[key] || 1 });
    });
  });

  const scored = Object.values(itemMap).map(entry => {
    const rarityWeight = entry.twinScores[0].rarityWeight;
    const twinCount = entry.twinScores.length;
    const avgTwinScore = entry.twinScores.reduce((a, b) => a + b.twinScore, 0) / twinCount;
    const rank = avgTwinScore * rarityWeight * Math.sqrt(twinCount);
    return { ...entry, twinCount, avgTwinScore: Math.round(avgTwinScore), rank, tier: 1 };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

// Tier 2 — neighbor-of-neighbor. One hop further: the user's twins' own top
// twins. Still zero AI.
function buildNeighborOfNeighborRecs(myUserId, myRatings, allRatings, excludeKeys, limit = RECS_TARGET) {
  const { topTwins, rarityWeights } = findTopTwins(myUserId, myRatings, allRatings, 10);
  const mineKeys = new Set(myRatings.map(r => `${r.category}:${r.item_name.toLowerCase()}`));
  const directTwinIds = new Set(topTwins.map(t => t.userId));
  const directTwinItemKeys = new Set();
  topTwins.forEach(t => t.ratings.forEach(r => directTwinItemKeys.add(`${r.category}:${r.item_name.toLowerCase()}`)));

  const secondDegree = {};
  topTwins.forEach(twin => {
    const { topTwins: theirTwins } = findTopTwins(twin.userId, twin.ratings, allRatings, 5);
    theirTwins.forEach(t2 => {
      if (t2.userId === myUserId || directTwinIds.has(t2.userId)) return;
      if (!secondDegree[t2.userId]) secondDegree[t2.userId] = { score: t2.score, ratings: t2.ratings };
    });
  });

  const itemMap = {};
  Object.values(secondDegree).forEach(({ score, ratings }) => {
    ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = `${r.category}:${r.item_name.toLowerCase()}`;
      if (mineKeys.has(key) || directTwinItemKeys.has(key) || excludeKeys.has(key)) return;
      if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, scores: [] };
      itemMap[key].scores.push(score);
    });
  });

  const scored = Object.values(itemMap).map(entry => {
    const count = entry.scores.length;
    const avgScore = entry.scores.reduce((a, b) => a + b, 0) / count;
    const rarityWeight = rarityWeights[`${entry.category}:${entry.item_name.toLowerCase()}`] || 1;
    const rank = avgScore * rarityWeight * Math.sqrt(count);
    return { ...entry, neighborCount: count, avgScore: Math.round(avgScore), rank, tier: 2 };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

// Tier 3 — archetype/community trending. Requires users.archetype to be
// populated (written on every /rate — see saveArchetypeForUser above).
async function buildArchetypeTrendingRecs(myArchetype, myUserId, allRatings, excludeKeys, limit = RECS_TARGET) {
  if (!myArchetype) return [];
  const sameArchetypeUsers = await sbFetch(`users?archetype=eq.${encodeURIComponent(myArchetype)}&select=id`);
  if (!sameArchetypeUsers?.length) return [];

  const peerIds = new Set(sameArchetypeUsers.map(u => u.id).filter(id => id !== myUserId));
  if (peerIds.size === 0) return [];

  const mineKeys = new Set(allRatings.filter(r => r.user_id === myUserId).map(r => `${r.category}:${r.item_name.toLowerCase()}`));
  const itemMap = {};
  allRatings.forEach(r => {
    if (!peerIds.has(r.user_id) || r.rating < 4) return;
    const key = `${r.category}:${r.item_name.toLowerCase()}`;
    if (mineKeys.has(key) || excludeKeys.has(key)) return;
    if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, count: 0, ratingSum: 0 };
    itemMap[key].count++;
    itemMap[key].ratingSum += r.rating;
  });

  const scored = Object.values(itemMap).map(entry => ({ ...entry, avgRating: entry.ratingSum / entry.count, tier: 3 }));
  scored.sort((a, b) => (b.count * b.avgRating) - (a.count * a.avgRating));
  return scored.slice(0, limit);
}

// Tier 4 — global trending/hidden gems. The floor for "real human data, no
// AI." For a very small user base this may legitimately come back empty.
function buildGlobalTrendingRecs(myUserId, allRatings, excludeKeys, limit = RECS_TARGET) {
  const mineKeys = new Set(allRatings.filter(r => r.user_id === myUserId).map(r => `${r.category}:${r.item_name.toLowerCase()}`));
  const itemMap = {};
  allRatings.forEach(r => {
    if (r.user_id === myUserId || r.rating < 4) return;
    const key = `${r.category}:${r.item_name.toLowerCase()}`;
    if (mineKeys.has(key) || excludeKeys.has(key)) return;
    if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, count: 0, ratingSum: 0 };
    itemMap[key].count++;
    itemMap[key].ratingSum += r.rating;
  });
  const scored = Object.values(itemMap).map(entry => ({ ...entry, avgRating: entry.ratingSum / entry.count, tier: 4 }));
  scored.sort((a, b) => (b.count * b.avgRating) - (a.count * a.avgRating));
  return scored.slice(0, limit);
}

// Tier 5 — AI last resort, ONLY called when tiers 1-4 produce nothing.
// Kept structurally separate from the real-data tiers — different embed
// section, explicit lower-trust framing — never blended or worded similarly.
async function generateAIFallbackPicks(ratings) {
  const topRated = ratings
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 10)
    .map(r => `${r.item_name} (${r.category}, ${r.rating}/5 stars)`)
    .join(', ');

  const prompt = `You are Kindred. This user has no taste-twin matches yet (too new, or too little catalog overlap with other users), so generate exactly 4 fallback picks based on general knowledge of their own ratings only. These are explicitly lower-trust than a human-matched pick, keep that framing in mind.

Their ratings: ${topRated}

Return ONLY a JSON object, no markdown, no backticks:
{"recommendations":[{"title":"string","category":"film|games|books","reason":"one sentence why"}]}`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return (parsed.recommendations || []).map(r => ({ ...r, tier: 5 }));
  } catch (e) {
    return [];
  }
}

// Builds the Discord embed fields for tiers 1-4 (real data), tagging each
// item with a short tier label so trust level is visible at a glance —
// same intent as the web app's tier badges, just rendered as embed text.
function formatTieredRecLine(item) {
  const icon = item.category === 'film' ? '🎬' : item.category === 'games' ? '🎮' : '📚';
  if (item.tier === 1) {
    const why = item.twinCount > 1 ? `${item.twinCount} of your Taste Neighbors rated this 4-5★` : `Your top taste twin loved this`;
    return `${icon} **${item.item_name}** - _${why}_ \`Twin-Backed\``;
  }
  if (item.tier === 2) {
    return `${icon} **${item.item_name}** - _${item.neighborCount} people in your extended taste network loved this_ \`Taste Network\``;
  }
  if (item.tier === 3) {
    return `${icon} **${item.item_name}** - _Popular among people who share your archetype (${item.count} loved it)_ \`Trending In Your Archetype\``;
  }
  return `${icon} **${item.item_name}** - _Trending across all of Kindred, ${item.avgRating.toFixed(1)}★ avg from ${item.count} people_ \`Kindred Trending\``;
}

// Builds a real button (not a markdown link) for each rec's buy link, so
// clicks can actually be tracked via affiliate_link_clicked — a plain
// hyperlink in embed text gives Discord no way to tell the bot it was
// clicked at all. Discord caps customId at 100 chars, and a long real
// title (encoded) can already exceed that on its own — so this encodes
// only a short position index, not the title. The button handler
// re-derives the actual rec list by re-running the same tier-building
// functions (deterministic given the same data), then looks up that
// position — same approach as recomputing rather than caching elsewhere
// in this bot.
function buildAffiliateButton(item, index) {
  const label = item.category === 'books' ? 'Find on Bookshop' : 'Find on Amazon';
  return new ButtonBuilder()
    .setCustomId(`buyrec_${index}`)
    .setLabel(`🛒 ${label}`)
    .setStyle(ButtonStyle.Secondary);
}



const commands = [
  new SlashCommandBuilder()
    .setName('rate')
    .setDescription('Rate a film, game, or book')
    .addStringOption(o => o.setName('category').setDescription('film, games, or books').setRequired(true)
      .addChoices({ name: 'film', value: 'film' }, { name: 'games', value: 'games' }, { name: 'books', value: 'books' }))
    .addStringOption(o => o.setName('title').setDescription('Title of the item').setRequired(true))
    .addIntegerOption(o => o.setName('stars').setDescription('Rating from 1 to 5').setRequired(true)
      .setMinValue(1).setMaxValue(5)),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('See your taste profile and ratings'),

  new SlashCommandBuilder()
    .setName('passport')
    .setDescription('See your Kindred Taste Passport: level, archetype, and freshness'),

  new SlashCommandBuilder()
    .setName('twin')
    .setDescription('Find your taste twin: the person who likes what you like'),

  new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('See what your #1 Taste Neighbor has rated recently'),

  new SlashCommandBuilder()
    .setName('recs')
    .setDescription('Get recommendations from real taste twins. AI only as a last resort'),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search real movies, TV, games, or books to rate')
    .addStringOption(o => o.setName('category').setDescription('film, games, or books').setRequired(true)
      .addChoices({ name: 'film', value: 'film' }, { name: 'games', value: 'games' }, { name: 'books', value: 'books' }))
    .addStringOption(o => o.setName('query').setDescription('What to search for').setRequired(true)),

  new SlashCommandBuilder()
    .setName('catalog')
    .setDescription('Learn how to search and rate things on Kindred'),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Connect your Discord ratings to your Kindred web account')
    .addStringOption(o => o.setName('code').setDescription('The code shown on kindredmatch.co').setRequired(true)),

  new SlashCommandBuilder()
    .setName('privacy-settings')
    .setDescription('View or change your data-sharing choice'),

  new SlashCommandBuilder()
    .setName('delete-account')
    .setDescription('Permanently delete your Kindred account and all your ratings'),

  new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('Read Kindred\'s Privacy Policy'),

  new SlashCommandBuilder()
    .setName('terms')
    .setDescription('Read Kindred\'s Terms of Service'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
  console.log('Slash commands registered');
}

// ─── CLIENT ──────────────────────────────────────────────────

const PURPLE = 0x7C3AED;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`Kindred bot online as ${client.user.tag}`));

// ─── INTERACTIONS ────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  // ─── BUTTON CLICKS (consent prompt, account deletion confirm) ──
  // Separate branch from slash commands — buttons need their own reply
  // flow (update the existing message, not defer+editReply like a fresh
  // slash command does).
  if (interaction.isButton()) {
    try {
      if (interaction.customId === 'consent_yes' || interaction.customId === 'consent_no') {
        const consent = interaction.customId === 'consent_yes';
        const dbUser = await getUserByDiscordId(interaction.user.id);
        if (dbUser) {
          await sbFetch(`users?id=eq.${dbUser.id}`, 'PATCH', {
            data_sharing_consent: consent,
            data_sharing_consent_prompted: true,
          });
          if (consent) await logBotEvent(dbUser.id, 'data_sharing_consent_given');
        }
        await interaction.update({
          content: consent ? '✅ Thanks for helping improve Kindred. You can change this anytime with `/privacy-settings`.' : 'No problem. You can opt in anytime with `/privacy-settings`.',
          components: [],
        });
        return;
      }
      // Distinct from the buttons above — this is the later Settings
      // toggle (/privacy-settings), not the one-time first-unlock prompt.
      // Does NOT touch data_sharing_consent_prompted (already true by
      // definition if someone's using this command), and logs the
      // "changed" event type instead of "given", matching the web app's
      // exact distinction between an initial decision and a later change.
      if (interaction.customId === 'settings_consent_on' || interaction.customId === 'settings_consent_off') {
        const consent = interaction.customId === 'settings_consent_on';
        const dbUser = await getUserByDiscordId(interaction.user.id);
        if (dbUser) {
          await sbFetch(`users?id=eq.${dbUser.id}`, 'PATCH', { data_sharing_consent: consent });
          await logBotEvent(dbUser.id, 'data_sharing_consent_changed', consent ? 'on' : 'off');
        }
        await interaction.update({
          content: `✅ Data sharing is now **${consent ? 'ON' : 'OFF'}**.`,
          components: [],
        });
        return;
      }
      if (interaction.customId === 'delete_confirm' || interaction.customId === 'delete_cancel') {
        if (interaction.customId === 'delete_cancel') {
          await interaction.update({ content: 'Account deletion cancelled. Nothing was changed.', components: [] });
          return;
        }
        const dbUser = await getUserByDiscordId(interaction.user.id);
        if (!dbUser) {
          await interaction.update({ content: 'Could not find an account to delete.', components: [] });
          return;
        }
        // Same explicit multi-table cleanup as the web app's deleteAccount —
        // confirmed no FK cascade exists in the database, so children must
        // be cleared before the users row, or they'd be left orphaned.
        await sbFetch(`tastes?user_id=eq.${dbUser.id}`, 'DELETE');
        await sbFetch(`events?user_id=eq.${dbUser.id}`, 'DELETE');
        await sbFetch(`matches?user_id_1=eq.${dbUser.id}`, 'DELETE');
        await sbFetch(`matches?user_id_2=eq.${dbUser.id}`, 'DELETE');
        await sbFetch(`users?id=eq.${dbUser.id}`, 'DELETE');
        await interaction.update({ content: '✅ Your Kindred account and all your ratings have been permanently deleted.', components: [] });
        return;
      }

      // ─── Affiliate buy-link buttons (from /recs) ──────────
      // customId only carries a position index (Discord's 100-char limit
      // makes embedding a full title unsafe — a single long real title can
      // already exceed that once URL-encoded). Re-derives the exact same
      // tier results the original /recs call produced, since the same
      // tier-building functions are deterministic given the same ratings
      // data, then looks up that position. Ephemeral reply since this is a
      // personal buy link, not something the whole channel needs to see.
      // EDGE CASE: if ratings change platform-wide between when /recs was
      // shown and when the button is clicked (new ratings from this user
      // or others), the re-derived list could theoretically shift and the
      // index could point at a different item than what was actually
      // displayed. Accepted tradeoff — building real position-locked state
      // would need a new table/schema for a fairly rare mismatch.
      if (interaction.customId.startsWith('buyrec_')) {
        const index = parseInt(interaction.customId.replace('buyrec_', ''), 10);
        const dbUser = await getUserByDiscordId(interaction.user.id);
        if (!dbUser || Number.isNaN(index)) {
          await interaction.reply({ content: 'Could not find that recommendation. Try `/recs` again.', ephemeral: true });
          return;
        }
        const myRatings = await getUserRatings(dbUser.id);
        const allRatings = await getAllRatings();
        const myArchetype = (await sbFetch(`users?id=eq.${dbUser.id}&select=archetype`))[0]?.archetype || null;

        const excludeKeys = new Set();
        const addToExclude = (items) => items.forEach(i => excludeKeys.add(`${i.category}:${i.item_name.toLowerCase()}`));
        let combined = [];
        const tier1 = buildTwinBackedRecs(dbUser.id, myRatings, allRatings, RECS_TARGET);
        addToExclude(tier1); combined = combined.concat(tier1);
        if (combined.length < RECS_TARGET) {
          const tier2 = buildNeighborOfNeighborRecs(dbUser.id, myRatings, allRatings, excludeKeys, RECS_TARGET - combined.length);
          addToExclude(tier2); combined = combined.concat(tier2);
        }
        if (combined.length < RECS_TARGET) {
          const tier3 = await buildArchetypeTrendingRecs(myArchetype, dbUser.id, allRatings, excludeKeys, RECS_TARGET - combined.length);
          addToExclude(tier3); combined = combined.concat(tier3);
        }
        if (combined.length < RECS_TARGET) {
          const tier4 = buildGlobalTrendingRecs(dbUser.id, allRatings, excludeKeys, RECS_TARGET - combined.length);
          addToExclude(tier4); combined = combined.concat(tier4);
        }

        const item = combined[index];
        if (!item) {
          await interaction.reply({ content: 'Could not find that recommendation anymore. Try `/recs` again for a fresh list.', ephemeral: true });
          return;
        }
        const link = await buildAffiliateLink(item.category, item.item_name);
        await logBotEvent(dbUser.id, 'affiliate_link_clicked', `${item.category}:${item.item_name}`);
        await interaction.reply({ content: `🛒 **${item.item_name}**\n${link}`, ephemeral: true });
        return;
      }
    } catch (err) {
      console.error('Button interaction error:', err);
      try { await interaction.update({ content: 'Something went wrong. Please try again.', components: [] }); } catch (e) {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  await interaction.deferReply();

  try {

    // ─── /rate ───────────────────────────────────────────
    if (commandName === 'rate') {
      const category = interaction.options.getString('category');
      const title    = interaction.options.getString('title');
      const stars    = interaction.options.getInteger('stars');

      const { user: dbUser, created } = await upsertUser(user.id, user.username);
      if (!dbUser) throw new Error('Could not create user profile.');
      if (created) await logBotEvent(dbUser.id, 'signup_completed');

      await saveRating(dbUser.id, category, title, stars);
      // Keep the archetype on file fresh — same Tier 3 dependency as the web
      // app. Fire-and-forget; doesn't block the rating confirmation below.
      saveArchetypeForUser(dbUser.id, user.username);
      // "Your twin changed" V1 — fire-and-forget, same reasoning as the web
      // app's equivalent call in setRating: a failed notification check
      // should never block the rating confirmation the user is waiting on.
      notifyTwinsOfNewRating(dbUser.id, category, title, stars);

      const starDisplay = '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle('✅ Rating Saved!')
        .setDescription(`**${title}** added to your taste profile.`)
        .addFields(
          { name: '📂 Category', value: category.charAt(0).toUpperCase() + category.slice(1), inline: true },
          { name: '⭐ Your Rating', value: starDisplay, inline: true },
        )
        .setFooter({ text: 'Use /twin to find your taste match · /profile to see all ratings' });

      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /profile ────────────────────────────────────────
    if (commandName === 'profile') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('No ratings yet. Use `/rate` to start, or try `/catalog` for ideas.');

      const ratings = await getUserRatings(dbUser.id);
      if (ratings.length === 0) return interaction.editReply('No ratings yet. Use `/rate` to start, or try `/catalog` for ideas.');

      const byCategory = { film: [], games: [], books: [] };
      ratings.forEach(r => {
        const cat = r.category || 'film';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(r);
      });

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle(`🎯 ${user.username}'s Taste Profile`)
        .setDescription(`**${ratings.length} total ratings** saved to Kindred`);

      const labels = { film: '🎬 Film & TV', games: '🎮 Games', books: '📚 Books' };
      Object.entries(byCategory).forEach(([cat, items]) => {
        if (items.length === 0) return;
        const lines = items
          .sort((a, b) => b.rating - a.rating)
          .slice(0, 5)
          .map(r => `${'⭐'.repeat(r.rating)} ${r.item_name}`)
          .join('\n');
        embed.addFields({ name: labels[cat], value: lines, inline: false });
      });

      embed.setFooter({ text: 'Use /twin to find your match · /recs for AI recommendations' });
      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /passport ───────────────────────────────────────
    if (commandName === 'passport') {
      const dbUser = await getUserByDiscordId(user.id);
      const ratings = dbUser ? await getUserRatings(dbUser.id) : [];

      if (ratings.length === 0) {
        return interaction.editReply('Your passport is blank so far. Use `/rate` to start filling it in!');
      }

      const level = getExplorerLevel(ratings.length);
      // Seed with dbUser.id (same as saveArchetypeForUser and the web app) so
      // the card shows the exact archetype that's stored on the account,
      // rather than a username-seeded variant that could pick a different
      // behavior synonym from the same bucket.
      const archetype = buildArchetype(dbUser.id, ratings);
      const png = renderPassportCardPNG({ archetype, level, total: ratings.length });
      const attachment = new AttachmentBuilder(png, { name: 'kindred-taste-passport.png' });
      // Bot always renders the image as part of the normal reply, no
      // separate share action to gate behind, same reasoning as
      // twin_card_shared on /twin.
      await logBotEvent(dbUser.id, 'taste_passport_shared', archetype.label);

      return interaction.editReply({
        content: `🪪 **${archetype.label}** - Level: ${level} · /rate to keep building it`,
        files: [attachment],
      });
    }

    // ─── /notifications ────────────────────────────────────
    // "Your twin changed" V1. Reading your own notifications is a plain
    // self-only query, no special key needed (the bot already runs on
    // service-role regardless, but this would work fine under regular RLS
    // too since user_id = the caller's own row).
    if (commandName === 'notifications') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate`, then come back!');

      const items = await sbFetch(
        `notifications?user_id=eq.${dbUser.id}&select=*&order=created_at.desc&limit=10`
      );
      if (!items.length) {
        return interaction.editReply('Nothing yet. We will let you know when your #1 Taste Neighbor rates something new.');
      }

      const twinIds = [...new Set(items.map(n => n.twin_user_id))];
      const twinRows = await sbFetch(`users?id=in.(${twinIds.join(',')})&select=id,username`);
      const nameMap = {};
      twinRows.forEach(u => { nameMap[u.id] = u.username; });

      const unreadIds = items.filter(n => !n.read).map(n => n.id);

      const lines = items.map(n => {
        const icon = n.category === 'film' ? '🎬' : n.category === 'games' ? '🎮' : '📚';
        const stars = '⭐'.repeat(n.rating);
        const name = nameMap[n.twin_user_id] || 'Someone';
        const marker = n.read ? '' : '🆕 ';
        return `${marker}${icon} **${name}** rated **${n.item_name}** ${stars}`;
      });

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle('🔔 Your Taste Neighbor Activity')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use /rate to add any of these to your own profile' });

      // Mark as read once shown, same as opening the web app's inbox panel.
      if (unreadIds.length > 0) {
        for (const id of unreadIds) {
          await sbFetch(`notifications?id=eq.${id}`, 'PATCH', { read: true }).catch(() => {});
        }
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /twin ───────────────────────────────────────────
    if (commandName === 'twin') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate`, then come back!');

      const myRatings  = await getUserRatings(dbUser.id);
      const allRatings = await getAllRatings();

      if (myRatings.length < TWIN_UNLOCK_THRESHOLD) {
        const remaining = TWIN_UNLOCK_THRESHOLD - myRatings.length;
        return interaction.editReply(`🔒 Rate ${remaining} more thing${remaining === 1 ? '' : 's'} to unlock your first twin. We hold off until there's enough signal for a match that actually feels right. You're at **${myRatings.length}/${TWIN_UNLOCK_THRESHOLD}**.`);
      }

      const { bestUserId, bestScore, rarityWeights } = findTwin(dbUser.id, myRatings, allRatings);
      const embed = new EmbedBuilder().setColor(PURPLE);
      let attachment = null;

      if (!bestUserId || bestScore === 0) {
        embed
          .setTitle('🔍 No Twin Found Yet')
          .setDescription('Not enough users have rated overlapping items yet.\n\nShare Kindred with friends to grow the pool!')
          .setFooter({ text: `Your profile has ${myRatings.length} ratings` });
      } else {
        const twinDbRow = await sbFetch(`users?id=eq.${bestUserId}&select=*`);
        const twinUsername = twinDbRow[0]?.username || 'Unknown User';

        const myMap = {};
        myRatings.forEach(r => { myMap[`${r.category}:${r.item_name.toLowerCase()}`] = r; });
        const theirRatings = allRatings.filter(r => r.user_id === bestUserId);
        const theirMap = {};
        theirRatings.forEach(r => { theirMap[`${r.category}:${r.item_name.toLowerCase()}`] = r; });

        // Sort shared favorites by rarity — rarest, most meaningful matches first.
        const shared = Object.keys(myMap)
          .filter(k => theirMap[k] && myMap[k].rating >= 4 && theirMap[k].rating >= 4)
          .map(k => ({ title: myMap[k].item_name, weight: (rarityWeights && rarityWeights[k]) || 1 }))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 3);

        const whyText = buildWhyText(shared.map(s => s.title));

        await saveMatch(dbUser.id, bestUserId, bestScore).catch(() => {});
        // first_match_unlocked: once per account, same as the web app's
        // logEventOnce. twin_card_shared: every time, since the bot always
        // renders and sends the image as part of the normal reply — there's
        // no separate "share" button to gate this behind like the web app
        // has, so this is the closest real equivalent.
        await logBotEventOnce(dbUser.id, 'first_match_unlocked', `${bestScore}%`);
        await logBotEvent(dbUser.id, 'twin_card_shared', `${bestScore}%`);

        embed
          .setTitle('🔗 Taste Twin Found!')
          .setDescription(
            `You and **${twinUsername}** share a **${bestScore}% taste match** across domains.` +
            (whyText ? `\n\n💡 ${whyText}` : '')
          )
          .addFields(
            { name: '📊 Match Score', value: `${bestScore}%`, inline: true },
            { name: '🎯 Your Ratings', value: `${myRatings.length} items`, inline: true },
          );

        if (shared.length > 0) {
          embed.addFields({ name: '❤️ You Both Love', value: shared.map(s => s.title).join('\n'), inline: false });
        }

        embed.setFooter({ text: 'Use /recs for AI recommendations · more ratings = better matches' });

        // Shareable image — same visual design as the web app's twin card,
        // so the match looks the same whether someone screenshots Discord
        // or shares straight from kindredmatch.co.
        const png = renderTwinCardPNG({
          overall: bestScore, handle: `@${twinUsername}`, why: whyText,
          shared: shared.map(s => s.title),
        });
        attachment = new AttachmentBuilder(png, { name: 'kindred-taste-twin.png' });
        embed.setImage('attachment://kindred-taste-twin.png');
      }

      return interaction.editReply(attachment ? { embeds: [embed], files: [attachment] } : { embeds: [embed] }).then(async () => {
        // One-time data-sharing consent prompt, mirrored from the web app's
        // trigger condition exactly: fires the first time a real twin is
        // found (not just when the gate clears), since that's the moment
        // trust is highest. Sent as a separate followUp so it doesn't
        // clutter the twin reveal embed itself. consent_prompted gates this
        // the same way it gates the web app's modal — ask once, never again.
        if (bestUserId && bestScore > 0 && !dbUser.data_sharing_consent_prompted) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('consent_no').setLabel('No thanks').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('consent_yes').setLabel('Yes, help improve Kindred').setStyle(ButtonStyle.Secondary),
          );
          await interaction.followUp({
            content: '**Help make Kindred smarter?**\n\nWhen you opt in, your taste data (anonymized, never your name or identity) helps us improve recommendations and build better tools for taste discovery. You can turn this off anytime with `/privacy-settings`.',
            components: [row],
          });
        }
      });
    }

    // ─── /recs ───────────────────────────────────────────
    if (commandName === 'recs') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate`, then come back for recommendations!');

      const myRatings = await getUserRatings(dbUser.id);
      // Same gate as /twin — below this there isn't enough signal for a
      // real twin-backed match, so recs would just be AI guesses dressed
      // up as something more trustworthy. Matches the web app's rule.
      if (myRatings.length < TWIN_UNLOCK_THRESHOLD) {
        const remaining = TWIN_UNLOCK_THRESHOLD - myRatings.length;
        return interaction.editReply(`🔒 Rate ${remaining} more thing${remaining === 1 ? '' : 's'} to unlock recommendations. You're at **${myRatings.length}/${TWIN_UNLOCK_THRESHOLD}**.`);
      }

      const allRatings = await getAllRatings();
      const myArchetype = (await sbFetch(`users?id=eq.${dbUser.id}&select=archetype`))[0]?.archetype || null;

      const excludeKeys = new Set();
      const addToExclude = (items) => items.forEach(i => excludeKeys.add(`${i.category}:${i.item_name.toLowerCase()}`));
      let combined = [];

      // Tier 1 — twin-backed
      const tier1 = buildTwinBackedRecs(dbUser.id, myRatings, allRatings, RECS_TARGET);
      addToExclude(tier1);
      combined = combined.concat(tier1);

      // Tier 2 — neighbor-of-neighbor
      if (combined.length < RECS_TARGET) {
        const tier2 = buildNeighborOfNeighborRecs(dbUser.id, myRatings, allRatings, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier2);
        combined = combined.concat(tier2);
      }

      // Tier 3 — archetype trending
      if (combined.length < RECS_TARGET) {
        const tier3 = await buildArchetypeTrendingRecs(myArchetype, dbUser.id, allRatings, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier3);
        combined = combined.concat(tier3);
      }

      // Tier 4 — global trending
      if (combined.length < RECS_TARGET) {
        const tier4 = buildGlobalTrendingRecs(dbUser.id, allRatings, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier4);
        combined = combined.concat(tier4);
      }

      const embed = new EmbedBuilder().setColor(PURPLE).setTitle(`✨ Kindred Picks for ${user.username}`);

      if (combined.length > 0) {
        embed
          .setDescription(combined.map(formatTieredRecLine).join('\n\n'))
          .setFooter({ text: 'Based on real taste twins, not AI guesses · Kindred earns a small commission on purchases through these links' });

        // Discord caps 5 buttons per row — split into rows of 5 if there
        // are more recs than that (RECS_TARGET is 6, so this can happen).
        const buttons = combined.map((item, i) => buildAffiliateButton(item, i));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));

        return interaction.editReply({ embeds: [embed], components: rows });
      }

      // Tier 5 — AI last resort, ONLY reached if tiers 1-4 found nothing.
      // Rendered as a visually separate embed section with explicit
      // lower-trust framing — never blended with the tiers above.
      const aiPicks = await generateAIFallbackPicks(myRatings);
      if (aiPicks.length === 0) {
        embed.setDescription('Could not generate recommendations right now. Try again in a moment.');
        return interaction.editReply({ embeds: [embed] });
      }
      embed
        .setTitle(`🌱 Beyond Your Taste Network - ${user.username}`)
        .setDescription(
          `No human taste-twin matches yet, so these are AI-generated guesses based only on your own ratings. Lower trust than the real-people picks Kindred normally shows.\n\n` +
          aiPicks.map(r => {
            const icon = r.category === 'film' ? '🎬' : r.category === 'games' ? '🎮' : '📚';
            return `${icon} **${r.title}** - _${r.reason}_`;
          }).join('\n\n')
        )
        .setFooter({ text: 'Rate more, or share Kindred with friends, to unlock real twin-backed picks' });
      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /search ─────────────────────────────────────────
    if (commandName === 'search') {
      const category = interaction.options.getString('category');
      const query    = interaction.options.getString('query');

      const results = await searchCatalog(category, query);

      if (results.length === 0) {
        return interaction.editReply(`No results found for "${query}". Try a different spelling or title.`);
      }

      const label = category === 'film' ? '🎬' : category === 'games' ? '🎮' : '📚';
      const lines = results.map((r, i) =>
        `**${i + 1}.** ${r.title}${r.year ? ` (${r.year})` : ''}${r.kind ? ` · *${r.kind}*` : ''}`
      ).join('\n');

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle(`${label} Search results for "${query}"`)
        .setDescription(lines)
        .setFooter({ text: `Use /rate ${category} "exact title" [1-5] to rate one of these` });

      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /catalog ────────────────────────────────────────
    if (commandName === 'catalog') {
      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle('📋 How to Rate on Kindred')
        .setDescription(
          'Kindred searches real, live catalogs, not a fixed list.\n\n' +
          '**Step 1:** Find something with `/search`\n' +
          '`/search category:film query:Inception`\n\n' +
          '**Step 2:** Rate it with `/rate` using the exact title shown\n' +
          '`/rate category:film title:Inception stars:5`\n\n' +
          'Works the same for `games` and `books`.'
        )
        .setFooter({ text: 'Kindred · search any movie, show, game, or book' });
      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /link ───────────────────────────────────────────
    // Merges a Discord-only account into the web account that generated
    // the code. This is the one place the bot reaches across accounts
    // (normally it only ever touches its own caller's row) — safe here
    // specifically because it's running on the service-role key, which
    // bypasses RLS by design. A plain web session intentionally CANNOT do
    // this merge itself: users_update_own only lets someone write to a row
    // where auth_id already matches their own session, so a signed-in user
    // has no way to write into a different (Discord-only) row even if they
    // wanted to. The actual cross-account move has to happen here.
    if (commandName === 'link') {
      const code = interaction.options.getString('code').trim().toUpperCase();

      const matches = await sbFetch(`users?link_code=eq.${encodeURIComponent(code)}&select=*`);
      const webRow = matches[0];
      if (!webRow) {
        return interaction.editReply('That code doesn\'t match anything. Generate a fresh one on kindredmatch.co and try again.');
      }
      if (!webRow.link_code_expires_at || new Date(webRow.link_code_expires_at) < new Date()) {
        return interaction.editReply('That code has expired. Generate a fresh one on kindredmatch.co. They last 10 minutes.');
      }
      if (webRow.discord_id) {
        return interaction.editReply('That web account is already connected to a Discord account.');
      }

      const discordRow = await getUserByDiscordId(user.id);

      if (!discordRow) {
        // No Discord-side data to merge — just attach this Discord ID
        // directly to the web row. The simple, common case for someone
        // linking before ever using the bot to rate anything.
        await sbFetch(`users?id=eq.${webRow.id}`, 'PATCH', {
          discord_id: user.id,
          link_code: null,
          link_code_expires_at: null,
        });
        return interaction.editReply('✅ Connected! Your Discord account is now linked to your Kindred web account.');
      }

      if (discordRow.id === webRow.id) {
        // Already the same row somehow (e.g. re-running /link after success).
        await sbFetch(`users?id=eq.${webRow.id}`, 'PATCH', { link_code: null, link_code_expires_at: null });
        return interaction.editReply('✅ This Discord account is already linked to that web account.');
      }

      // Real merge case: two separate rows, two separate rating histories.
      // Move every tastes row from the Discord-only row onto the web row's
      // id, then remove the now-empty Discord row. tastes/matches/events
      // all reference users.id directly, so once the rows are reassigned
      // there, twin-matching and recs automatically see the combined set —
      // no other table needs to change.
      const discordRatings = await getUserRatings(discordRow.id);
      const webRatings = await getUserRatings(webRow.id);
      const webKeys = new Set(webRatings.map(r => `${r.category}:${r.item_name.toLowerCase()}`));

      let moved = 0, skipped = 0;
      for (const r of discordRatings) {
        const key = `${r.category}:${r.item_name.toLowerCase()}`;
        if (webKeys.has(key)) {
          // Same title rated on both platforms — keep the web account's
          // existing rating rather than overwrite it, and drop the
          // duplicate Discord-side row so there's no leftover conflict.
          await sbFetch(`tastes?id=eq.${r.id}`, 'DELETE');
          skipped++;
        } else {
          await sbFetch(`tastes?id=eq.${r.id}`, 'PATCH', { user_id: webRow.id });
          moved++;
        }
      }

      // The Discord row's tastes are now moved/dropped. Before deleting the
      // row itself, clean up the OTHER tables that reference it by user_id —
      // otherwise they're left pointing at a user that no longer exists
      // (the database has no FK cascade, confirmed). This mirrors the same
      // explicit multi-table discipline /delete-account uses.
      //  - events: reassign to the web row so the analytics history (signups,
      //    first match, consent, shares) carries over to the kept account
      //    instead of being stranded.
      //  - matches: transient and recomputed on every /twin, so just clear
      //    the discord row's match rows (both id columns) rather than remap.
      await sbFetch(`events?user_id=eq.${discordRow.id}`, 'PATCH', { user_id: webRow.id });
      await sbFetch(`matches?user_id_1=eq.${discordRow.id}`, 'DELETE');
      await sbFetch(`matches?user_id_2=eq.${discordRow.id}`, 'DELETE');

      // The Discord row is now empty (every tastes row moved or dropped) —
      // safe to delete it entirely rather than leave an orphaned duplicate
      // account sitting in the table.
      await sbFetch(`users?id=eq.${discordRow.id}`, 'DELETE');
      await sbFetch(`users?id=eq.${webRow.id}`, 'PATCH', {
        discord_id: user.id,
        link_code: null,
        link_code_expires_at: null,
      });

      const summary = skipped > 0
        ? `Merged ${moved} rating${moved===1?'':'s'} (kept your web account's version for ${skipped} item${skipped===1?'':'s'} rated on both).`
        : `Merged ${moved} rating${moved===1?'':'s'} from Discord into your web account.`;
      return interaction.editReply(`✅ Connected! ${summary} Your Discord and web ratings now combine for twin matching and recs.`);
    }

    // ─── /privacy-settings ────────────────────────────────
    // Discord's equivalent of the web app's Settings toggle — needed
    // because a Discord-only user has no web Settings screen to use
    // otherwise, and their data_sharing_consent would be permanently
    // stuck at its default with no way to ever change it.
    if (commandName === 'privacy-settings') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate` to create your Kindred profile.');

      const current = !!dbUser.data_sharing_consent;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('settings_consent_off').setLabel('Turn off').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings_consent_on').setLabel('Turn on').setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({
        content: `**Data sharing is currently: ${current ? 'ON' : 'OFF'}**\n\nWhen on, your anonymized taste data helps improve recommendations and build future taste-discovery tools. Never your name or identity.`,
        components: [row],
      });
    }

    // ─── /delete-account ──────────────────────────────────
    // Discord's equivalent of the web app's account deletion. Needed for
    // the same reason as /privacy-settings — Discord-only users have no
    // other way to exercise this right, and the Privacy Policy promises
    // it's available "anytime in Settings," which for Discord means here.
    if (commandName === 'delete-account') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('No Kindred account found for this Discord account.');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('delete_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('delete_confirm').setLabel('Yes, delete everything').setStyle(ButtonStyle.Danger),
      );
      return interaction.editReply({
        content: '⚠️ This will permanently delete your Kindred account and every rating you\'ve made. This cannot be undone.',
        components: [row],
      });
    }

    // ─── /privacy, /terms ──────────────────────────────────
    // Link to the real policy pages on the web app rather than
    // reproducing the full text inside a Discord embed — the web app is
    // the canonical source, this just points there.
    if (commandName === 'privacy') {
      return interaction.editReply('📄 Read Kindred\'s Privacy Policy: https://kindredmatch.co (link at the bottom of the page, no sign-in needed)');
    }
    if (commandName === 'terms') {
      return interaction.editReply('📄 Read Kindred\'s Terms of Service: https://kindredmatch.co (link at the bottom of the page, no sign-in needed)');
    }

  } catch (err) {
    console.error('Command error:', err);
    return interaction.editReply('Something went wrong. Please try again in a moment.');
  }
});

// ─── START ───────────────────────────────────────────────────
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
