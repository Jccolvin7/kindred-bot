// ============================================================
// KINDRED DISCORD BOT — Supabase Edition
// Commands: /rate /profile /twin /recs /catalog /search
// Identity: Discord ID (no email needed)
// Database: Supabase (users, tastes, matches tables)
// ============================================================

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, PermissionFlagsBits } from 'discord.js';
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
const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID; // Joshua's Discord user id -- used to gate /server-count to the actual owner (not just any per-server admin) and as the DM target for join/leave notifications

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

// Called (fire-and-forget) whenever a user saves a rating, from any rating
// path (/rate, the Rate Another flow). Advances the daily streak using the
// pure computeStreakAfterRating rules, but ONLY writes if something
// actually changed — rating five things in one day shouldn't fire five
// identical PATCHes. dbUser is the already-fetched row (every rating path
// already has it in hand) so this adds no extra read. Non-critical: a
// failed streak update should never affect the rating itself, so the
// caller never awaits the result in a way that blocks the confirmation.
async function advanceStreakForRating(dbUser) {
  try {
    const today = todayUTC();
    const current = dbUser.streak_count || 0;
    const next = computeStreakAfterRating(current, dbUser.last_streak_date, today);
    // Only write when the streak value or the date actually moves. If the
    // user already advanced today, next === current AND last_streak_date
    // is already today, so there's nothing to persist.
    if (next === current && dbUser.last_streak_date === today) return current;
    await sbFetch(`users?id=eq.${dbUser.id}`, 'PATCH', {
      streak_count: next,
      last_streak_date: today,
    });
    // Keep the in-memory row consistent for any later use in the same
    // handler (e.g. the confirmation message reading the new streak).
    dbUser.streak_count = next;
    dbUser.last_streak_date = today;
    return next;
  } catch (e) {
    return dbUser.streak_count || 0;
  }
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

// Server-tracking helpers (Files and Codes 5 handoff).
//
// events.user_id is nullable (confirmed via schema check) and
// events.created_at is NOT NULL with an automatic default, so every
// event already gets a real timestamp for free with zero migration
// needed — this just adds new event_type values on top of the existing
// table, following the exact same {user_id, event_type, detail} shape
// already used everywhere else in this file.
//
// detail is a single text column (not jsonb), so server context is
// encoded as "server:<id>:<name>" -- consistent with how other event
// types already pack short context into detail as plain strings (e.g.
// "film:Inception", "94%"). Easy to parse later with split_part() if
// this ever needs querying directly in SQL.
function serverDetail(serverId, serverName, extra) {
  const base = `server:${serverId}:${serverName || 'unknown'}`;
  return extra ? `${base}:${extra}` : base;
}

// Logs a /rate action tied to the server it happened in. Server-level
// event (no specific user tied to the ACTION of rating, even though the
// user themselves is known) -- but we DO have dbUser here at every call
// site, so user_id is included for free; only DMs (no guild) omit
// server context, which is expected and handled below.
async function logRatingServerEvent(dbUserId, interaction, category, title) {
  // interaction.guildId is null when a command is run in a DM rather
  // than a server -- that's a real, valid case (not every /rate happens
  // inside a server), so this just skips server tagging rather than
  // logging a misleading server_id.
  if (!interaction.guildId) return;
  try {
    await logBotEvent(
      dbUserId,
      'rating_logged',
      serverDetail(interaction.guildId, interaction.guild?.name, `${category}:${title}`)
    );
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

// Single source of truth for star display — always filled + empty out of
// 5, so a 2-star and a 5-star rating are visually distinguishable
// everywhere (some call sites previously showed filled-only with no
// ceiling, e.g. /profile and /notifications, making a 2★ item look the
// same shape as a 5★ one at a glance).
function starBar(rating) {
  const r = Math.max(0, Math.min(5, rating || 0));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

// Small text progress bar for the twin-unlock countdown — turns "3 more
// ratings to unlock" from plain text into something that visually reads as
// progress, matching the spirit of the streak system already built.
function progressBar(current, total, width = 8) {
  const c = Math.max(0, Math.min(total, current));
  const filled = Math.round((c / total) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled) + ` ${c}/${total}`;
}

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

// ─── "RATE ANOTHER" FLOW STATE ─────────────────────────────────
// Holds in-memory state for the button -> modal -> select-menu -> star-click
// chain triggered by the "🔍 Rate another" button on every rating
// confirmation. Keyed by Discord user id. Deliberately NOT encoded into
// customId (the way the existing buyrec_ buttons encode a position) because
// a search query has no safe length guarantee against Discord's 100-char
// customId limit, and an in-memory map sidesteps that entirely. Tradeoff:
// state is lost if the bot restarts mid-flow (rare, and the flow only
// spans a few seconds of real user time), in which case the affected
// button/menu just fails gracefully and tells the user to tap "Rate
// another" again — same accepted-tradeoff spirit as buyrec_'s re-derivation
// approach elsewhere in this file. Cleared on flow completion or on a
// fresh restart of the flow.
const activeRateFlows = new Map();

// Holds the original typed title for the "Save anyway" path on /rate's
// catalog-mismatch warning. Same reasoning as activeRateFlows above: a
// free-text title has no safe length guarantee against Discord's 100-char
// customId limit, so this stays in memory rather than encoded into the
// button's customId. Keyed by Discord user id; cleared on use or overwritten
// by a fresh /rate call before this one is acted on.
const pendingForceRate = new Map();

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

// ─── DAILY CHALLENGE + STREAK ──────────────────────────────────
// Retention engine: a self-contained daily reason to come back that works
// with ZERO other users online (unlike the twin-changed notification,
// which depends on someone else rating something). The challenge targets
// the user's weakest domain — which doubles as a product win, since it
// pushes them to fill in the thin parts of their taste fingerprint and
// makes their eventual twin match more accurate. The streak is the actual
// stickiness; the targeted challenge is just what makes each day's return
// worth doing.

// All date math is done in UTC on YYYY-MM-DD strings. Using a date STRING
// (not a Date object or timestamp) sidesteps timezone/DST drift entirely:
// two events on the same UTC calendar day always compare equal, and
// "yesterday" is a clean -1 day on a normalized midnight-UTC value. A
// per-user local-timezone streak would be nicer but needs the user's tz,
// which the bot doesn't have — UTC is the honest, consistent choice.
function todayUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function daysBetweenUTC(fromDateStr, toDateStr) {
  // Whole-day difference between two 'YYYY-MM-DD' strings. Parsed as
  // midnight UTC (the trailing Z) so no local-timezone offset creeps in.
  const a = new Date(`${fromDateStr}T00:00:00Z`).getTime();
  const b = new Date(`${toDateStr}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// Pure function — given the user's stored streak state and today's date,
// returns what the streak should become after a rating today. Kept pure
// (no DB, no side effects) precisely so it can be unit-tested for the
// fiddly cases: same-day repeat, consecutive day, one-day grace, full
// reset. Rules:
//   - Already advanced today        -> unchanged (rating again same day
//                                       doesn't double-count)
//   - Exactly 1 day since last (or first ever, or grace day) -> +1
//   - 2 days since last (missed exactly one day) -> the streak was frozen
//     with a warning yesterday; rating now still counts as continuing it,
//     so +1 from where it was (this is the "one free grace day")
//   - 3+ days since last (missed two or more) -> reset to 1 (today starts
//     a fresh streak)
//   - No prior streak date at all -> 1
function computeStreakAfterRating(streakCount, lastStreakDate, today) {
  if (!lastStreakDate) return 1;
  const gap = daysBetweenUTC(lastStreakDate, today);
  if (gap <= 0) return streakCount;        // already counted today (or clock skew) — no change
  if (gap === 1) return streakCount + 1;   // consecutive day
  if (gap === 2) return streakCount + 1;   // missed exactly one day — grace day still continues it
  return 1;                                // missed 2+ days — fresh start
}

// Whether the streak is currently in its single "grace day" — i.e. the
// user missed yesterday but can still save the streak by rating today.
// Used only for messaging ("rate today to keep your streak alive!").
function isStreakInGrace(lastStreakDate, today) {
  if (!lastStreakDate) return false;
  return daysBetweenUTC(lastStreakDate, today) === 2;
}

// Builds the one-line streak message appended to a rating confirmation.
// Returns '' when there's nothing worth saying (streak of 0/1 on a fresh
// account doesn't need fanfare). Milestone days get a little extra.
function streakConfirmationLine(streakCount) {
  if (!streakCount || streakCount < 2) return '';
  const milestone = streakCount % 7 === 0 ? ' 🎉 A full week!' : '';
  return `\n\n🔥 **${streakCount}-day streak!**${milestone} Come back tomorrow to keep it going.`;
}

// Pick the daily challenge domain: the user's weakest (fewest-rated)
// domain, so the challenge actively strengthens the thin part of their
// taste fingerprint. Deterministic given the same ratings, so calling
// /daily twice in a day shows the same challenge. Ties broken by a fixed
// priority order rather than randomness, again for stability.
const DAILY_DOMAIN_LABELS = {
  film: { label: 'a movie or show', emoji: '🎬' },
  games: { label: 'a game', emoji: '🎮' },
  books: { label: 'a book', emoji: '📚' },
};

function pickDailyChallengeDomain(ratings) {
  const counts = { film: 0, games: 0, books: 0 };
  ratings.forEach(r => { if (counts[r.category] !== undefined) counts[r.category]++; });
  // Lowest count wins; stable tie-break order film -> games -> books
  // (the iteration order below, with strict < so the first of equal-lowest
  // is kept).
  let best = 'film';
  let bestCount = Infinity;
  ['film', 'games', 'books'].forEach(d => {
    if (counts[d] < bestCount) { bestCount = counts[d]; best = d; }
  });
  return { domain: best, count: counts[best], counts };
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

  new SlashCommandBuilder()
    .setName('website')
    .setDescription('Get the link to kindredmatch.co'),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Your daily taste challenge — keep your streak alive'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('See what Kindred can do and how to get started'),

  new SlashCommandBuilder()
    .setName('server-count')
    .setDescription('[Admin only] Live count of servers Kindred is currently in')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
  console.log('Slash commands registered');
}

// ─── CLIENT ──────────────────────────────────────────────────

// Embed colors — matches the web app's palette exactly so the bot feels
// like the same product, not a generic gray-purple Discord bot. PURPLE
// stays the default/brand color (used for passport, help, catalog, generic
// confirmations); the rest are used contextually per command below.
const PURPLE = 0x7C3AED;
const CYAN   = 0x06B6D4; // games
const AMBER  = 0xF59E0B; // books
const FILM_PURPLE = 0x8B5CF6; // film & TV (slightly lighter than brand purple)
const PINK   = 0xFF689D; // twin match — mirrors the web app's twin-card pink
const GREEN  = 0x10B981; // success / streak
const GRAY   = 0x6B7280; // AI fallback / lower-trust tier
const RED    = 0xEF4444; // errors / not-found states

function colorForCategory(category) {
  if (category === 'film') return FILM_PURPLE;
  if (category === 'games') return CYAN;
  if (category === 'books') return AMBER;
  return PURPLE;
}

// Logo thumbnail shown on key embeds (twin match, passport, recs, help).
// NOTE: this is a Discord CDN attachment link, which carries expiring
// signature params (ex=/is=/hm=) and can rotate over time. If thumbnails
// silently stop appearing later (Discord just omits a broken image, so
// this fails quietly rather than erroring), re-upload the logo and swap
// this URL — ideally for a permanent one hosted on kindredmatch.co itself
// (e.g. via the web app's /public folder) once that's convenient.
const LOGO_URL = 'https://cdn.discordapp.com/attachments/1517313909089112066/1520956555166748865/IMG_1247.png?ex=6a4314ac&is=6a41c32c&hm=314215d0d330258d86c09c351940768cf4000435b954353b35a3a629fad36383&';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`Kindred bot online as ${client.user.tag}`));

// ─── SERVER TRACKING (Files and Codes 5 handoff) ──────────────────
// guildCreate/guildDelete fire whenever the bot is added to or removed
// from a server. GatewayIntentBits.Guilds (already enabled above) is
// the only intent these require -- no intent change needed.
//
// Logged as events with user_id: null, since these are server-level
// occurrences with no specific user attached to the action of adding/
// removing a bot from a server -- confirmed events.user_id is nullable
// via schema check, so this needs no workaround or separate table.
//
// Member count is captured here specifically because it can ONLY be
// captured at this moment -- Discord doesn't expose "member count when
// the bot joined" after the fact, only the current count. Outreach
// targets the 500-10,000 member range, so this is what lets that be
// checked against reality later rather than assumed.
client.on('guildCreate', async (guild) => {
  try {
    await logBotEvent(null, 'bot_added_to_server', serverDetail(guild.id, guild.name, `members:${guild.memberCount}`));
  } catch (e) { console.error('Failed to log bot_added_to_server:', e); }

  try {
    if (OWNER_DISCORD_ID) {
      const owner = await client.users.fetch(OWNER_DISCORD_ID);
      await owner.send(`✅ Bot added to **${guild.name}** (${guild.memberCount.toLocaleString()} members)`);
    }
  } catch (e) {
    // DMs can fail for reasons outside the bot's control (owner has DMs
    // closed, hasn't shared a server with this bot account, etc.) --
    // this should never be allowed to look like the join itself failed,
    // so it's logged but otherwise swallowed.
    console.error('Failed to DM owner about guildCreate:', e);
  }
});

client.on('guildDelete', async (guild) => {
  try {
    await logBotEvent(null, 'bot_removed_from_server', serverDetail(guild.id, guild.name));
  } catch (e) { console.error('Failed to log bot_removed_from_server:', e); }

  try {
    if (OWNER_DISCORD_ID) {
      const owner = await client.users.fetch(OWNER_DISCORD_ID);
      await owner.send(`❌ Bot removed from **${guild.name}**.`);
    }
  } catch (e) {
    console.error('Failed to DM owner about guildDelete:', e);
  }
});

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
      // ─── "Save anyway" button from the /rate catalog-mismatch warning ──
      // Reads the pending title/category/stars out of pendingForceRate (see
      // that map's declaration for why this is in-memory state rather than
      // customId encoding) and saves exactly as originally typed.
      if (interaction.customId === 'rate_force_save') {
        const pending = pendingForceRate.get(interaction.user.id);
        if (!pending) {
          await interaction.update({ content: 'That request expired. Try `/rate` again.', embeds: [], components: [] });
          return;
        }
        pendingForceRate.delete(interaction.user.id);
        const { category, title, stars } = pending;

        const { user: dbUser, created } = await upsertUser(interaction.user.id, interaction.user.username);
        if (!dbUser) {
          await interaction.update({ content: 'Could not create your profile. Try `/rate` again.', embeds: [], components: [] });
          return;
        }
        if (created) await logBotEvent(dbUser.id, 'signup_completed');

        await saveRating(dbUser.id, category, title, stars);
        saveArchetypeForUser(dbUser.id, interaction.user.username);
        notifyTwinsOfNewRating(dbUser.id, category, title, stars);
        logRatingServerEvent(dbUser.id, interaction, category, title);

        const myRatingsNow = await getUserRatings(dbUser.id);
        const remainingToUnlock = TWIN_UNLOCK_THRESHOLD - myRatingsNow.length;
        const newStreak = await advanceStreakForRating(dbUser);

        const embed = new EmbedBuilder()
          .setColor(colorForCategory(category))
          .setTitle('✅ Rating Saved!')
          .setDescription(
            `**${title}** added to your taste profile as typed.` +
            (remainingToUnlock > 0
              ? `\n\n🔓 **${progressBar(myRatingsNow.length, TWIN_UNLOCK_THRESHOLD)}** to unlock your taste twin!`
              : '') +
            streakConfirmationLine(newStreak)
          )
          .addFields(
            { name: '📂 Category', value: category.charAt(0).toUpperCase() + category.slice(1), inline: true },
            { name: '⭐ Your Rating', value: starBar(stars), inline: true },
          )
          .setFooter({ text: 'Use /twin to find your taste match · /profile to see all ratings' });

        await interaction.update({ embeds: [embed], components: [] });
        return;
      }
      // ─── "Rate another" button (opens the search modal) ──
      // Category was encoded in the customId at confirmation time (short,
      // fixed set of values — film/games/books — so this is safe within
      // Discord's customId length limit, unlike a free-text title would be).
      if (interaction.customId.startsWith('rate_another_')) {
        const defaultCategory = interaction.customId.replace('rate_another_', '');
        const modal = new ModalBuilder()
          .setCustomId(`rate_search_modal_${defaultCategory}`)
          .setTitle('Find something to rate');

        const categoryInput = new TextInputBuilder()
          .setCustomId('modal_category')
          .setLabel('Category (film, games, or books)')
          .setStyle(TextInputStyle.Short)
          .setValue(defaultCategory)
          .setRequired(true);
        const queryInput = new TextInputBuilder()
          .setCustomId('modal_query')
          .setLabel('What are you rating?')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Dune, Hades, Project Hail Mary')
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(categoryInput),
          new ActionRowBuilder().addComponents(queryInput),
        );
        await interaction.showModal(modal);
        return;
      }

      // ─── Star-rating buttons (final step of the Rate Another flow) ──
      // Reads the title/category the user picked from the select menu out
      // of activeRateFlows (see that map's declaration for why this is
      // in-memory state rather than customId encoding).
      if (interaction.customId.startsWith('rate_star_')) {
        const stars = parseInt(interaction.customId.replace('rate_star_', ''), 10);
        const flow = activeRateFlows.get(interaction.user.id);
        if (!flow || !flow.selectedTitle) {
          await interaction.update({ content: 'That search expired. Tap "🔍 Rate another" to start a new one.', embeds: [], components: [] });
          return;
        }
        const { category, selectedTitle } = flow;

        const dbUser = await getUserByDiscordId(interaction.user.id);
        if (!dbUser) {
          await interaction.update({ content: 'Could not find your profile. Try `/rate` directly instead.', embeds: [], components: [] });
          return;
        }

        await saveRating(dbUser.id, category, selectedTitle, stars);
        saveArchetypeForUser(dbUser.id, interaction.user.username);
        notifyTwinsOfNewRating(dbUser.id, category, selectedTitle, stars);
        logRatingServerEvent(dbUser.id, interaction, category, selectedTitle);
        activeRateFlows.delete(interaction.user.id);

        const myRatingsNow = await getUserRatings(dbUser.id);
        const remainingToUnlock = TWIN_UNLOCK_THRESHOLD - myRatingsNow.length;
        const newStreak = await advanceStreakForRating(dbUser);
        const starDisplay = starBar(stars);

        const embed = new EmbedBuilder()
          .setColor(colorForCategory(category))
          .setTitle('✅ Rating Saved!')
          .setDescription(
            `**${selectedTitle}** added to your taste profile.` +
            (remainingToUnlock > 0
              ? `\n\n🔓 **${progressBar(myRatingsNow.length, TWIN_UNLOCK_THRESHOLD)}** to unlock your taste twin!`
              : '') +
            streakConfirmationLine(newStreak)
          )
          .addFields(
            { name: '📂 Category', value: category.charAt(0).toUpperCase() + category.slice(1), inline: true },
            { name: '⭐ Your Rating', value: starDisplay, inline: true },
          )
          .setFooter({ text: 'Use /twin to find your taste match · /profile to see all ratings' });

        const rateAnotherRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rate_another_${category}`).setLabel('🔍 Rate another').setStyle(ButtonStyle.Secondary),
        );

        await interaction.update({ embeds: [embed], components: [rateAnotherRow] });
        return;
      }

    } catch (err) {
      console.error('Button interaction error:', err);
      try { await interaction.update({ content: 'Something went wrong. Please try again.', components: [] }); } catch (e) {}
    }
    return;
  }

  // ─── SELECT MENU (picking a search result in the Rate Another flow) ──
  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'rate_pick') {
        const flow = activeRateFlows.get(interaction.user.id);
        if (!flow || !flow.results) {
          await interaction.update({ content: 'That search expired. Tap "🔍 Rate another" to start a new one.', components: [] });
          return;
        }
        const index = parseInt(interaction.values[0], 10);
        const picked = flow.results[index];
        if (!picked) {
          await interaction.update({ content: 'Could not find that result anymore. Tap "🔍 Rate another" to search again.', components: [] });
          return;
        }
        // Extend the same flow-state entry with the chosen title so the
        // star-button step (final stage of this same flow) can read it.
        activeRateFlows.set(interaction.user.id, { ...flow, selectedTitle: picked.title });

        const starRow = new ActionRowBuilder().addComponents(
          [1, 2, 3, 4, 5].map(n =>
            new ButtonBuilder().setCustomId(`rate_star_${n}`).setLabel('⭐'.repeat(n)).setStyle(ButtonStyle.Secondary)
          )
        );
        await interaction.update({
          content: `**${picked.title}**${picked.year ? ` (${picked.year})` : ''}\nHow many stars?`,
          components: [starRow],
        });
        return;
      }
    } catch (err) {
      console.error('Select menu interaction error:', err);
      try { await interaction.update({ content: 'Something went wrong. Please try again.', components: [] }); } catch (e) {}
    }
    return;
  }

  // ─── MODAL SUBMIT (search query from the Rate Another flow) ──
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId.startsWith('rate_search_modal_')) {
        // Defer immediately — searchCatalog hits an external API (TMDB/
        // RAWG/Open Library) and isn't guaranteed to finish inside
        // Discord's 3-second initial-response window. Slash commands get
        // this same protection for free from the single deferReply() call
        // above interaction.isChatInputCommand(), but THAT call never runs
        // for a modal submission — this is a separate interaction type and
        // needs its own defer.
        await interaction.deferReply({ ephemeral: true });

        const category = interaction.fields.getTextInputValue('modal_category').trim().toLowerCase();
        const query = interaction.fields.getTextInputValue('modal_query').trim();

        if (!['film', 'games', 'books'].includes(category)) {
          await interaction.editReply('Category must be "film", "games", or "books". Tap "🔍 Rate another" to try again.');
          return;
        }

        const results = await searchCatalog(category, query);
        if (!results || results.length === 0) {
          await interaction.editReply(`No results found for "${query}". Try different terms, or use \`/search\` directly.`);
          return;
        }

        // Cap at 25 — Discord's hard limit on select menu options.
        const capped = results.slice(0, 25);
        activeRateFlows.set(interaction.user.id, { category, query, results: capped });

        const menu = new StringSelectMenuBuilder()
          .setCustomId('rate_pick')
          .setPlaceholder('Pick the right one...')
          .addOptions(capped.map((r, i) => ({
            label: (r.title + (r.year ? ` (${r.year})` : '')).slice(0, 100),
            value: String(i),
            ...(r.kind ? { description: r.kind.slice(0, 100) } : {}),
          })));
        const row = new ActionRowBuilder().addComponents(menu);
        await interaction.editReply({ content: `Results for **${query}**:`, components: [row] });
        return;
      }
    } catch (err) {
      console.error('Modal submit error:', err);
      try {
        if (interaction.deferred) await interaction.editReply('Something went wrong. Please try again.');
        else await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
      } catch (e) {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  // /server-count replies ephemerally (visible only to the admin who ran
  // it) -- has to defer this way BEFORE the blanket deferReply below,
  // since a reply already deferred non-ephemerally can't be made
  // ephemeral afterward via editReply. Every other command keeps the
  // existing public-reply behavior untouched.
  if (commandName === 'server-count') {
    await interaction.deferReply({ ephemeral: true });
    if (interaction.user.id !== OWNER_DISCORD_ID) {
      return interaction.editReply('This command is restricted.');
    }
    const guildCount = client.guilds.cache.size;
    const embed = new EmbedBuilder()
      .setColor(PURPLE)
      .setThumbnail(LOGO_URL)
      .setTitle('📊 Live Server Count')
      .setDescription(`Kindred is currently active in **${guildCount}** server${guildCount === 1 ? '' : 's'}.`)
      .setFooter({ text: 'Live count from client.guilds.cache — not a historical figure' });
    return interaction.editReply({ embeds: [embed] });
  }

  await interaction.deferReply();

// Lightweight fuzzy match for soft-validating /rate against the live
// catalog. Not a full Levenshtein implementation — deliberately simple
// (exact, substring, or shared-word match) since the goal is only to catch
// "user typed something basically right, just unconfirmed" vs. "this looks
// like a likely typo or made-up title," not to be a spellchecker.
function findCloseCatalogMatch(query, results) {
  const q = query.trim().toLowerCase();
  return results.find(r => {
    const t = r.title.trim().toLowerCase();
    if (t === q) return true;
    if (t.includes(q) || q.includes(t)) return true;
    const qWords = q.split(/\s+/).filter(w => w.length > 2);
    const tWords = t.split(/\s+/).filter(w => w.length > 2);
    const overlap = qWords.filter(w => tWords.includes(w));
    return qWords.length > 0 && overlap.length / qWords.length >= 0.6;
  }) || null;
}

  try {

    // ─── /rate ───────────────────────────────────────────
    if (commandName === 'rate') {
      const category = interaction.options.getString('category');
      const title    = interaction.options.getString('title');
      const stars    = interaction.options.getInteger('stars');

      // Soft-validate against the live catalog before saving. This protects
      // twin-match data quality (two people's casing/spelling of the same
      // real title needs to line up for matching to work) without removing
      // the documented "/rate category title stars" fast path — if nothing
      // close is found, we warn and offer the search-and-pick flow as a
      // fallback, but still let the user save their typed title as-is via
      // the same "Rate another" search flow if they confirm it's correct.
      // Wrapped in try/catch so a flaky search API never blocks rating —
      // degrades to the old direct-save behavior on any search failure.
      let catalogMatch = null;
      try {
        const candidates = await searchCatalog(category, title);
        catalogMatch = findCloseCatalogMatch(title, candidates || []);
      } catch (e) { /* search unavailable — fall through to direct save */ }

      if (!catalogMatch) {
        pendingForceRate.set(user.id, { category, title, stars });
        const tryAgainRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rate_another_${category}`).setLabel('🔍 Search & pick the right one').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('rate_force_save').setLabel(`Save "${title}" anyway`.slice(0, 80)).setStyle(ButtonStyle.Secondary),
        );
        const warnEmbed = new EmbedBuilder()
          .setColor(GRAY)
          .setTitle('🤔 Couldn\'t confirm that title')
          .setDescription(
            `**"${title}"** didn't closely match anything in our live catalog for **${category}**.\n\n` +
            `This matters for matching — if your spelling/casing differs from how someone else rated the same thing, Kindred won't recognize it as the same title. Search and pick the exact one, or save it as typed if you're confident it's right.`
          );
        return interaction.editReply({ embeds: [warnEmbed], components: [tryAgainRow] });
      }

      const { user: dbUser, created } = await upsertUser(user.id, user.username);
      if (!dbUser) throw new Error('Could not create user profile.');
      if (created) await logBotEvent(dbUser.id, 'signup_completed');

      // Save under the catalog's exact title/casing, not whatever the user
      // typed — this is the actual data-quality fix. The confirmation below
      // still shows it clearly so there's no surprise about what got saved.
      const confirmedTitle = catalogMatch.title;

      await saveRating(dbUser.id, category, confirmedTitle, stars);
      // Keep the archetype on file fresh — same Tier 3 dependency as the web
      // app. Fire-and-forget; doesn't block the rating confirmation below.
      saveArchetypeForUser(dbUser.id, user.username);
      // "Your twin changed" V1 — fire-and-forget, same reasoning as the web
      // app's equivalent call in setRating: a failed notification check
      // should never block the rating confirmation the user is waiting on.
      notifyTwinsOfNewRating(dbUser.id, category, confirmedTitle, stars);
      logRatingServerEvent(dbUser.id, interaction, category, confirmedTitle);

      // Progress nudge: counts down toward the existing 8-rating unlock
      // gate. Needs the POST-save count, so re-fetch rather than trust a
      // value computed before saveRating ran. Stops appearing once the
      // gate is already open — no reason to keep counting toward
      // something that's already unlocked.
      const myRatingsNow = await getUserRatings(dbUser.id);
      const remainingToUnlock = TWIN_UNLOCK_THRESHOLD - myRatingsNow.length;

      // Advance the daily streak (any rating counts toward it). Mutates
      // dbUser in place and returns the new value for the confirmation
      // line. Awaited because we display the result, but wrapped so a
      // failure degrades to "no streak line" rather than breaking the
      // rating confirmation.
      const newStreak = await advanceStreakForRating(dbUser);

      const starDisplay = starBar(stars);
      const embed = new EmbedBuilder()
        .setColor(colorForCategory(category))
        .setTitle('✅ Rating Saved!')
        .setDescription(
          `**${confirmedTitle}** added to your taste profile.` +
          (confirmedTitle.toLowerCase() !== title.trim().toLowerCase() ? `\n_(matched from "${title}")_` : '') +
          (remainingToUnlock > 0
            ? `\n\n🔓 **${progressBar(myRatingsNow.length, TWIN_UNLOCK_THRESHOLD)}** to unlock your taste twin!`
            : '') +
          streakConfirmationLine(newStreak)
        )
        .addFields(
          { name: '📂 Category', value: category.charAt(0).toUpperCase() + category.slice(1), inline: true },
          { name: '⭐ Your Rating', value: starDisplay, inline: true },
        )
        .setFooter({ text: 'Use /twin to find your taste match · /profile to see all ratings' });

      // "Rate another" button: reopens the same search-and-pick flow /search
      // already uses (via searchCatalog, no new search/matching logic),
      // through a modal + select menu instead of retyping /rate from
      // scratch. Defaults the flow's starting category to whatever was
      // just rated, since "rate another one of these" is the common case.
      const rateAnotherRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rate_another_${category}`).setLabel('🔍 Rate another').setStyle(ButtonStyle.Secondary),
      );

      return interaction.editReply({ embeds: [embed], components: [rateAnotherRow] });
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
          .map(r => `${starBar(r.rating)} ${r.item_name}`)
          .join('\n');
        embed.addFields({ name: labels[cat], value: lines, inline: false });
      });

      embed.setFooter({ text: 'Use /twin to find your match · /recs for your recommendations' });
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
        content: `🪪 **${archetype.label}** - Level: ${level}` +
          ((dbUser.streak_count || 0) >= 2 ? ` · 🔥 ${dbUser.streak_count}-day streak` : '') +
          ` · /rate to keep building it`,
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
        const stars = starBar(n.rating);
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
        return interaction.editReply(`🔒 **Your first twin is close.** Rate ${remaining} more thing${remaining === 1 ? '' : 's'} to unlock it — we hold off until there's enough signal for a match that actually feels right.\n\n${progressBar(myRatings.length, TWIN_UNLOCK_THRESHOLD)}`);
      }

      const { bestUserId, bestScore, rarityWeights } = findTwin(dbUser.id, myRatings, allRatings);
      const embed = new EmbedBuilder().setColor(bestUserId && bestScore > 0 ? PINK : GRAY).setThumbnail(LOGO_URL);
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

        embed.setFooter({ text: 'Use /recs to see your recommendations · more ratings = better matches' });

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
        // Two independent one-time prompts, deliberately combined into a
        // SINGLE followUp message rather than each firing separately —
        // the twin reveal above is already the real payoff moment for this
        // command; stacking a second AND third popup behind it would bury
        // that. Per the handoff: reveal first (no competition), then one
        // combined "consent ask + web mention" message, never three
        // separate messages.
        //
        // showConsent: existing trigger, unchanged — first real twin found.
        // showWebNudge: NEW, its own independent gate (web_nudge_shown),
        // not nested inside showConsent's condition. That matters for
        // anyone who already passed the consent prompt before this nudge
        // existed (a real possibility once this ships to people who
        // started using the bot earlier) — they'd never see showConsent
        // fire again, but should still get one chance at the web nudge on
        // this same "real twin found" moment. Skipped entirely for anyone
        // already linked (auth_id present on their row) — they've already
        // made the jump this nudge is pointing them toward.
        const showConsent = bestUserId && bestScore > 0 && !dbUser.data_sharing_consent_prompted;
        const showWebNudge = bestUserId && bestScore > 0 && !dbUser.web_nudge_shown && !dbUser.auth_id;

        if (showConsent || showWebNudge) {
          const components = [];
          let content = '';

          if (showConsent) {
            content = '**Help make Kindred smarter?**\n\nWhen you opt in, your taste data (anonymized, never your name or identity) helps us improve recommendations and build better tools for taste discovery. You can turn this off anytime with `/privacy-settings`.';
            components.push(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('consent_no').setLabel('No thanks').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('consent_yes').setLabel('Yes, help improve Kindred').setStyle(ButtonStyle.Secondary),
              )
            );
          }

          if (showWebNudge) {
            // Italicized rather than a separate message — quiet/secondary
            // by tone, not by a separate popup. Kept to the exact one-line
            // copy from the handoff.
            const nudgeLine = '*Want your full Taste Passport, shareable cards, and a heads-up when your twin\'s taste shifts? Link your account at kindredmatch.co*';
            content = content ? `${content}\n\n${nudgeLine}` : nudgeLine;
          }

          await interaction.followUp({ content, components });

          if (showWebNudge) {
            await sbFetch(`users?id=eq.${dbUser.id}`, 'PATCH', { web_nudge_shown: true }).catch(() => {});
          }
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

      const embed = new EmbedBuilder().setColor(PURPLE).setThumbnail(LOGO_URL).setTitle(`✨ Kindred Picks for ${user.username}`);

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
      // lower-trust framing — never blended with the tiers above. Switching
      // the embed color to gray (vs. brand purple for real twin-backed
      // picks) reinforces that visual distinction at a glance, not just in
      // the text.
      const aiPicks = await generateAIFallbackPicks(myRatings);
      embed.setColor(GRAY);
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

      // Cap at 25 — Discord's hard limit on select menu options. Same flow
      // shape as the modal-driven "Rate another" path, so /search now feeds
      // straight into select -> star-buttons instead of dead-ending into
      // "now go type /rate with the exact title."
      const capped = results.slice(0, 25);
      activeRateFlows.set(user.id, { category, query, results: capped });

      const menu = new StringSelectMenuBuilder()
        .setCustomId('rate_pick')
        .setPlaceholder('Tap to rate one of these...')
        .addOptions(capped.map((r, i) => ({
          label: (r.title + (r.year ? ` (${r.year})` : '')).slice(0, 100),
          value: String(i),
          ...(r.kind ? { description: r.kind.slice(0, 100) } : {}),
        })));
      const row = new ActionRowBuilder().addComponents(menu);

      const embed = new EmbedBuilder()
        .setColor(colorForCategory(category))
        .setTitle(`${label} Search results for "${query}"`)
        .setDescription(lines)
        .setFooter({ text: 'Pick one below to rate it directly — no need to retype /rate' });

      return interaction.editReply({ embeds: [embed], components: [row] });
    }

    // ─── /catalog ────────────────────────────────────────
    if (commandName === 'catalog') {
      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setThumbnail(LOGO_URL)
        .setTitle('📋 How to Rate on Kindred')
        .setDescription(
          'Kindred searches real, live catalogs, not a fixed list.\n\n' +
          '**Easiest:** `/search` and tap a result to rate it directly — no retyping needed.\n' +
          '`/search category:film query:Inception`\n\n' +
          '**Or rate directly:** `/rate` with the exact title\n' +
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

    // ─── /daily ────────────────────────────────────────────
    // Self-contained daily retention hook: shows today's challenge (the
    // user's weakest domain), their current streak, and — if they're in
    // the one-day grace window — a "rate today to save it" warning. This
    // command only DISPLAYS state; the streak is actually advanced by
    // rating (advanceStreakForRating runs on every /rate), so /daily is a
    // read, not a write, except for stamping last_daily_challenge so the
    // suggested domain stays stable across repeated calls in one day.
    if (commandName === 'daily') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) {
        return interaction.editReply('Start your taste profile first with `/rate`, then come back for your daily challenge!');
      }
      const ratings = await getUserRatings(dbUser.id);
      const today = todayUTC();

      const { domain } = pickDailyChallengeDomain(ratings);
      const { label, emoji } = DAILY_DOMAIN_LABELS[domain];

      // Has the user already advanced their streak today (i.e. already
      // rated something since midnight UTC)?
      const ratedToday = dbUser.last_streak_date === today;
      const inGrace = isStreakInGrace(dbUser.last_streak_date, today);
      const streak = dbUser.streak_count || 0;

      // Stamp that we showed a challenge today (keeps the domain stable if
      // they run /daily again later today). Fire-and-forget.
      if (dbUser.last_daily_challenge !== today) {
        sbFetch(`users?id=eq.${dbUser.id}`, 'PATCH', { last_daily_challenge: today }).catch(() => {});
      }

      const embed = new EmbedBuilder().setColor(streak > 0 && !ratedToday ? GREEN : colorForCategory(domain)).setTitle('🎯 Your Daily Taste Challenge');

      let desc = `Today's pick: **rate ${label}** ${emoji}`;
      // Only frame it as filling a gap when it genuinely is one — if they
      // have a balanced profile, don't claim a domain is "light".
      const { counts } = pickDailyChallengeDomain(ratings);
      const total = counts.film + counts.games + counts.books;
      if (total > 0 && counts[domain] < total / 3) {
        desc += `\n_Your taste map is light on ${domain === 'film' ? 'film & TV' : domain} — filling it in sharpens your matches._`;
      }

      if (ratedToday) {
        desc += `\n\n✅ You've already rated today — your streak is safe. Rate ${label} anyway to strengthen your profile!`;
      } else if (inGrace && streak > 0) {
        desc += `\n\n⚠️ **Your ${streak}-day streak is about to break!** Rate something today to save it.`;
      } else if (streak > 0) {
        desc += `\n\n🔥 You're on a **${streak}-day streak.** Rate something today to keep it going.`;
      } else {
        desc += `\n\nRate something today to start a streak. 🔥`;
      }

      embed.setDescription(desc).setFooter({ text: 'Tap below to rate now · streaks build with any rating, any day' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rate_another_${domain}`).setLabel(`🔍 Rate ${label}`).setStyle(ButtonStyle.Secondary),
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }

    // ─── /website ──────────────────────────────────────────
    // Fallback for anyone who missed the one-time link nudge. Contextual
    // on actual link status (auth_id present = already linked, same check
    // used everywhere else this needs to be known) so it never tells an
    // already-linked user to go link again.
    if (commandName === 'website') {
      const dbUser = await getUserByDiscordId(user.id);
      const alreadyLinked = !!(dbUser && dbUser.auth_id);
      if (alreadyLinked) {
        return interaction.editReply('🔗 You\'re already linked! Visit https://kindredmatch.co to see your full Taste Passport and manage your settings.');
      }
      return interaction.editReply('🌐 Visit https://kindredmatch.co and use `/link` to connect your Discord account — see your full Taste Passport, shareable cards, and get notified when your twin\'s taste shifts.');
    }

    // ─── /help ─────────────────────────────────────────────
    // Grouped by purpose (get started -> see your matches -> account),
    // not an alphabetical dump — the goal is guiding someone toward their
    // first rating, not documenting every command that exists.
    if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setAuthor({ name: 'Kindred', iconURL: LOGO_URL })
        .setThumbnail(LOGO_URL)
        .setTitle('🔮 What Kindred Can Do')
        .setDescription('Kindred finds your taste twin: someone whose ratings match yours closely enough that their other favorites become a great bet for what you\'ll love next.')
        .addFields(
          { name: '🎬 Get started', value: '`/rate` — rate a movie, show, book, or game\n`/search` — find something to rate\n`/daily` — your daily taste challenge (keeps your streak alive)\n`/catalog` — browse ideas if you\'re not sure what to rate', inline: false },
          { name: '🔗 See your matches', value: '`/twin` — find your taste twin (unlocks after 8 ratings)\n`/recs` — get recommendations from people like you\n`/passport` — see your Taste Passport\n`/notifications` — see what your taste neighbor rated recently', inline: false },
          { name: '⚙️ Account', value: '`/link` — connect your Discord ratings to a web account\n`/website` — get the link to kindredmatch.co\n`/privacy-settings` · `/delete-account` · `/privacy` · `/terms`', inline: false },
        )
        .setFooter({ text: 'Start with /rate — your first 8 ratings unlock your taste twin' });
      return interaction.editReply({ embeds: [embed] });
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
