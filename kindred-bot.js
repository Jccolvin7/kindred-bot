// ============================================================
// KINDRED DISCORD BOT — Supabase Edition
// Commands: /rate /profile /twin /recs /catalog
// Identity: Discord ID (no email needed)
// Database: Supabase (users, tastes, matches tables)
// ============================================================

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';

// ─── ENV VARS (set these in Railway) ────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

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
  const rows = await sbFetch('users', 'POST', {
    discord_id: discordId,
    username: username,
  });
  if (!rows || rows.length === 0) {
    const existing = await sbFetch(`users?discord_id=eq.${discordId}&select=*`);
    return existing[0];
  }
  return rows[0];
}

async function saveRating(userId, category, itemName, rating) {
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

async function saveMatch(userId1, userId2, score) {
  await sbFetch('matches', 'POST', {
    user_id_1: userId1,
    user_id_2: userId2,
    match_score: score,
  });
}

// ─── TASTE TWIN MATCHING ─────────────────────────────────────

function computeMatchScore(myRatings, theirRatings) {
  const myMap = {};
  myRatings.forEach(r => { myMap[r.item_name.toLowerCase()] = r.rating; });
  const theirMap = {};
  theirRatings.forEach(r => { theirMap[r.item_name.toLowerCase()] = r.rating; });

  const sharedItems = Object.keys(myMap).filter(k => theirMap[k] !== undefined);
  if (sharedItems.length === 0) return 0;

  let totalScore = 0;
  sharedItems.forEach(item => {
    const diff = Math.abs(myMap[item] - theirMap[item]);
    if (diff === 0) totalScore += 100;
    else if (diff === 1) totalScore += 70;
    else if (diff === 2) totalScore += 30;
    else totalScore += 0;
  });

  return Math.round(totalScore / sharedItems.length);
}

function findTwin(myUserId, myRatings, allRatings) {
  const byUser = {};
  allRatings.forEach(r => {
    if (r.user_id === myUserId) return;
    if (!byUser[r.user_id]) byUser[r.user_id] = [];
    byUser[r.user_id].push(r);
  });

  let bestUserId = null;
  let bestScore = 0;

  Object.entries(byUser).forEach(([uid, theirRatings]) => {
    const score = computeMatchScore(myRatings, theirRatings);
    if (score > bestScore) {
      bestScore = score;
      bestUserId = uid;
    }
  });

  return { bestUserId, bestScore };
}

// ─── SLASH COMMANDS ──────────────────────────────────────────

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
    .setName('twin')
    .setDescription('Find your taste twin — the person who likes what you like'),

  new SlashCommandBuilder()
    .setName('recs')
    .setDescription('Get AI-powered cross-domain recommendations based on your taste'),

  new SlashCommandBuilder()
    .setName('catalog')
    .setDescription('Browse things to rate')
    .addStringOption(o => o.setName('domain').setDescription('Filter by domain').setRequired(false)
      .addChoices({ name: 'film', value: 'film' }, { name: 'games', value: 'games' }, { name: 'books', value: 'books' })),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
  console.log('Slash commands registered');
}

// ─── CATALOG ─────────────────────────────────────────────────

const CATALOG = {
  film: [
    { emoji: '🎬', title: 'Inception', genre: 'Sci-Fi Thriller' },
    { emoji: '🎬', title: 'The Shawshank Redemption', genre: 'Drama' },
    { emoji: '🎬', title: 'Parasite', genre: 'Thriller' },
    { emoji: '🎬', title: 'Interstellar', genre: 'Sci-Fi' },
    { emoji: '🎬', title: 'The Dark Knight', genre: 'Action' },
    { emoji: '🎬', title: 'Everything Everywhere All at Once', genre: 'Sci-Fi Comedy' },
  ],
  games: [
    { emoji: '🎮', title: 'The Last of Us', genre: 'Action-Adventure' },
    { emoji: '🎮', title: 'Elden Ring', genre: 'RPG' },
    { emoji: '🎮', title: 'Hollow Knight', genre: 'Metroidvania' },
    { emoji: '🎮', title: 'Stardew Valley', genre: 'Simulation' },
    { emoji: '🎮', title: 'Disco Elysium', genre: 'RPG' },
    { emoji: '🎮', title: 'Red Dead Redemption 2', genre: 'Action-Adventure' },
  ],
  books: [
    { emoji: '📚', title: 'Dune', genre: 'Sci-Fi' },
    { emoji: '📚', title: 'The Road', genre: 'Post-Apocalyptic' },
    { emoji: '📚', title: 'Sapiens', genre: 'Non-Fiction' },
    { emoji: '📚', title: 'Project Hail Mary', genre: 'Sci-Fi' },
    { emoji: '📚', title: 'The Name of the Wind', genre: 'Fantasy' },
    { emoji: '📚', title: 'Atomic Habits', genre: 'Self-Help' },
  ],
};

// ─── CLIENT ──────────────────────────────────────────────────

const PURPLE = 0x7C3AED;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`Kindred bot online as ${client.user.tag}`));

// ─── INTERACTIONS ────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  await interaction.deferReply();

  try {

    // ─── /rate ───────────────────────────────────────────
    if (commandName === 'rate') {
      const category = interaction.options.getString('category');
      const title    = interaction.options.getString('title');
      const stars    = interaction.options.getInteger('stars');

      const dbUser = await upsertUser(user.id, user.username);
      if (!dbUser) throw new Error('Could not create user profile.');

      await saveRating(dbUser.id, category, title, stars);

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
      if (!dbUser) return interaction.editReply('No ratings yet. Use `/rate` to start — try `/catalog` for ideas.');

      const ratings = await getUserRatings(dbUser.id);
      if (ratings.length === 0) return interaction.editReply('No ratings yet. Use `/rate` to start — try `/catalog` for ideas.');

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

    // ─── /twin ───────────────────────────────────────────
    if (commandName === 'twin') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate`, then come back!');

      const myRatings  = await getUserRatings(dbUser.id);
      const allRatings = await getAllRatings();

      if (myRatings.length < 3) {
        return interaction.editReply(`You need at least 3 ratings to find a twin. You have **${myRatings.length}** so far. Use \`/rate\` to add more!`);
      }

      const { bestUserId, bestScore } = findTwin(dbUser.id, myRatings, allRatings);
      const embed = new EmbedBuilder().setColor(PURPLE);

      if (!bestUserId || bestScore === 0) {
        embed
          .setTitle('🔍 No Twin Found Yet')
          .setDescription('Not enough users have rated overlapping items yet.\n\nShare Kindred with friends to grow the pool!')
          .setFooter({ text: `Your profile has ${myRatings.length} ratings` });
      } else {
        const twinDbRow = await sbFetch(`users?id=eq.${bestUserId}&select=*`);
        const twinUsername = twinDbRow[0]?.username || 'Unknown User';

        const myMap = {};
        myRatings.forEach(r => { myMap[r.item_name.toLowerCase()] = r; });
        const theirRatings = allRatings.filter(r => r.user_id === bestUserId);
        const theirMap = {};
        theirRatings.forEach(r => { theirMap[r.item_name.toLowerCase()] = r; });

        const shared = Object.keys(myMap)
          .filter(k => theirMap[k] && myMap[k].rating >= 4 && theirMap[k].rating >= 4)
          .slice(0, 3)
          .map(k => myMap[k].item_name);

        await saveMatch(dbUser.id, bestUserId, bestScore).catch(() => {});

        embed
          .setTitle('🔗 Taste Twin Found!')
          .setDescription(`You and **${twinUsername}** share a **${bestScore}% taste match** across domains.`)
          .addFields(
            { name: '📊 Match Score', value: `${bestScore}%`, inline: true },
            { name: '🎯 Your Ratings', value: `${myRatings.length} items`, inline: true },
          );

        if (shared.length > 0) {
          embed.addFields({ name: '❤️ You Both Love', value: shared.join('\n'), inline: false });
        }

        embed.setFooter({ text: 'Use /recs for AI recommendations · more ratings = better matches' });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /recs ───────────────────────────────────────────
    if (commandName === 'recs') {
      const dbUser = await getUserByDiscordId(user.id);
      if (!dbUser) return interaction.editReply('Rate some things first with `/rate`, then come back for recommendations!');

      const ratings = await getUserRatings(dbUser.id);
      if (ratings.length < 3) {
        return interaction.editReply(`You need at least 3 ratings for good recommendations. You have **${ratings.length}** so far.`);
      }

      const topRated = ratings
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 10)
        .map(r => `${r.item_name} (${r.category}, ${r.rating}/5 stars)`)
        .join(', ');

      const prompt = `You are Kindred, a cross-domain taste matching assistant. Based on this person's ratings: ${topRated}

Give them 6 personalized recommendations — 2 films/shows, 2 games, 2 books — that match their taste fingerprint. Focus on cross-domain connections (e.g. "if you loved X game, you'll love Y film because..."). Be specific and enthusiastic. Format as:

🎬 Film: [Title] — [one sentence why]
🎬 Film: [Title] — [one sentence why]
🎮 Game: [Title] — [one sentence why]
🎮 Game: [Title] — [one sentence why]
📚 Book: [Title] — [one sentence why]
📚 Book: [Title] — [one sentence why]`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const aiData = await aiRes.json();
      const recsText = aiData.content?.[0]?.text || 'Could not generate recommendations right now.';

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle(`✨ Kindred Picks for ${user.username}`)
        .setDescription(recsText)
        .setFooter({ text: 'Based on your real saved ratings · powered by Kindred AI' });

      return interaction.editReply({ embeds: [embed] });
    }

    // ─── /catalog ────────────────────────────────────────
    if (commandName === 'catalog') {
      const domain = interaction.options.getString('domain');
      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle('📋 Kindred Catalog')
        .setDescription('Rate these with `/rate` to build your taste profile.\nYou can also rate anything not on the list!');

      const domains = domain ? [domain] : ['film', 'games', 'books'];
      domains.forEach(d => {
        const label = d === 'film' ? '🎬 Film & TV' : d === 'games' ? '🎮 Games' : '📚 Books';
        const items = CATALOG[d].map(i => `${i.emoji} **${i.title}** · *${i.genre}*`).join('\n');
        embed.addFields({ name: label, value: items, inline: false });
      });

      embed.setFooter({ text: 'Kindred · /rate [film|games|books] [title] [1-5]' });
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
