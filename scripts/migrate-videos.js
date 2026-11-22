'use strict';

/**
 * Migrates the videos and votings of the legacy PHP API into Strapi:
 *   getGames → `video` attached to the championship `match` (the legacy "game" was a second copy of the
 *   match: it is linked to the existing match, or created as a new match; non-match groups such as the
 *   Entenrennen become matches of competition "Event" with a title),
 *   getGoalOfTheSeason → `poll` goalOfTheYear with one `poll-option` per nominated goal video
 *   (the legacy votes per player move to that player's video),
 *   getPlayerOfTheSeason → `poll` playerOfTheYear with one option per player.
 *
 * Usage: node scripts/migrate-videos.js --exports <dir with the PHP JSON exports>
 * Run the club and championship migrations first (players, matches). Safe to re-run before the website
 * switch: entries are matched and updated (videos by URL). After the switch, votes are cast in Strapi and
 * a re-run would reset them to the PHP counts.
 */

const path = require('path');
const { createCounter, parseArgs, readSource, runMigration, setPublicPermissions, upsert } = require('./lib/migrate-utils');

const OWN_TEAM = 'HV TDP Stainz';

/** Last names in the scorer texts that belong to more than one player. */
const LAST_NAME_OVERRIDES = { Grundner: 'Christian Grundner' };

/**
 * Legacy games whose match cannot be derived from title, round, date or score: the fields of the existing
 * match, or null for a match missing in the championship data (created from the game).
 */
const MATCH_OVERRIDES = {
  // Round 14 (5:3) is not in getMatchInfo; without the override it would be mixed up with another Hohenburg match.
  '2024-2025|2025-06-28|SK Hohenburg : HV TDP Stainz': null,
};

/** The final of the 13th Hallenturnier (January 2023) was entered twice, once with the wrong season. */
const EVENT_TITLE_ALIASES = { '13. Stainzer Hallenturnier - das Finale': 'Finale 13. Stainzer Hallenturnier' };
const EVENT_SEASONS = { 'Finale 13. Stainzer Hallenturnier': '2022-2023' };

/** Older votings ran on external survey pages. */
const SURVEY_LINKS = {
  2022: 'https://www.umfrageonline.com/c/zwsdprsc',
  2023: 'https://www.umfrageonline.com/c/djhufanr',
};

const toInt = (value) => {
  const number = parseInt(value, 10);
  return Number.isNaN(number) ? null : number;
};

/**
 * Team names are spelled differently in the two legacy tables ("Gößnitz"/"Gössnitz", extra spaces) and
 * clubs changed their prefix over the years ("HFC Mein Lokal Gössnitz" / "STT Mein Lokal Gössnitz").
 */
const normalizeTeam = (team) =>
  (team || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hfc|stt|sk|fc|sv|gsv|spg|fk|hc) /, '');
const sameTeam = (a, b) => {
  const [x, y] = [normalizeTeam(a), normalizeTeam(b)];
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};

/** "Home : Away", "Home - Away", "Home vs. Away" → [home, away] if the own team plays, else null (an event). */
function parseTeams(title) {
  const parts = title.split(/\s*:\s*|\s+-\s+|\s+vs\.\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 && parts.some((part) => part.includes(OWN_TEAM)) ? parts : null;
}

/** Same label rules as the championship migration ("Cup Achtelfinale", "Testspiel"). */
function parseLabel(label) {
  const text = (label || '').trim();
  let match;
  if (text === 'Testspiel' || text === 'Highlights') return { competition: 'Testspiel', round: null, stage: null };
  if ((match = /^Cup (\d+)\. Runde$/.exec(text))) return { competition: 'Cup', round: Number(match[1]), stage: null };
  if ((match = /^Cup (.+)$/.exec(text))) return { competition: 'Cup', round: null, stage: match[1] };
  return null;
}

runMigration(async () => {
  const args = parseArgs(['exports']);
  const source = (endpoint) => readSource(path.join(args.exports, `${endpoint}.json`));
  const counter = createCounter();
  const report = [];

  const games = await source('getGames');
  const goalOptions = await source('getGoalOfTheSeason');
  const playerOptions = await source('getPlayerOfTheSeason');

  // Players (from the club migration)
  const players = await strapi.documents('api::player.player').findMany({ limit: 1000 });
  const byFullName = new Map(players.map((player) => [`${player.firstName} ${player.lastName}`, player]));
  const byLastName = new Map();
  players.forEach((player) => byLastName.set(player.lastName, [...(byLastName.get(player.lastName) ?? []), player]));
  /** "Jaindl" or "Hendler Paul" → player (null if unknown or ambiguous). */
  const playerOf = (scorer) => {
    if (LAST_NAME_OVERRIDES[scorer]) return byFullName.get(LAST_NAME_OVERRIDES[scorer]) ?? null;
    if (scorer.includes(' ')) {
      const [lastName, ...firstNames] = scorer.split(' ');
      return byFullName.get(`${firstNames.join(' ')} ${lastName}`) ?? null;
    }
    const found = byLastName.get(scorer) ?? [];
    return found.length === 1 ? found[0] : null;
  };

  // Seasons: video seasons before the championship data (2017-2018, 2018-2019) are created without a league.
  const seasons = {};
  for (const key of [...new Set(games.map((game) => game.season))]) {
    const existing = await strapi.documents('api::season.season').findFirst({ filters: { key } });
    seasons[key] = existing ? existing.documentId : (await strapi.documents('api::season.season').create({ data: { key } })).documentId;
    if (!existing) counter.add('season', 'created');
  }

  const matches = await strapi.documents('api::match.match').findMany({ limit: 5000, populate: { season: { fields: ['key'] } } });

  /** Existing match of a legacy game, or null. */
  const findMatch = (game, teams) => {
    const title = game.description.trim();
    const inSeason = matches.filter((match) => match.season?.key === game.season);
    const overrideKey = `${game.season}|${game.date}|${title}`;
    const override = MATCH_OVERRIDES[overrideKey];
    if (overrideKey in MATCH_OVERRIDES && !override) {
      return null;
    }
    if (override) {
      return inSeason.find((match) => Object.entries(override).every(([key, value]) => match[key] === value)) ?? null;
    }
    let candidates = inSeason.filter((match) => sameTeam(match.homeTeam, teams[0]) && sameTeam(match.awayTeam, teams[1]));
    if (candidates.length > 1) {
      const round = toInt(game.round);
      const narrowed = candidates.filter(
        (match) =>
          (round && match.round === round) ||
          (game.date && match.date === game.date) ||
          (game.homeScore !== null && match.homeScore === toInt(game.homeScore) && match.awayScore === toInt(game.awayScore))
      );
      candidates = narrowed.length ? narrowed : candidates;
    }
    if (candidates.length > 1) report.push(`game "${title}" (${game.season}, ${game.date}) fits ${candidates.length} matches → first one used`);
    return candidates[0] ?? null;
  };

  /** Finds or creates the match a legacy game belongs to; fills in a missing date. */
  const matchOf = async (game) => {
    const title = game.description.trim();
    const teams = parseTeams(title);
    let match = teams ? findMatch(game, teams) : null;
    if (!match) {
      let data;
      let season = game.season;
      if (teams) {
        const round = toInt(game.round);
        data = {
          ...(parseLabel(game.customText) ??
            (round && round < 99 ? { competition: 'Meisterschaft', round, stage: null } : { competition: 'Testspiel', round: null, stage: null })),
          homeTeam: teams[0],
          awayTeam: teams[1],
          title: null,
          homeScore: toInt(game.homeScore),
          awayScore: toInt(game.awayScore),
        };
      } else {
        // Events: the title is the description, or the custom text if there is no description.
        const eventTitle = EVENT_TITLE_ALIASES[title] ?? (title || game.customText.trim());
        season = EVENT_SEASONS[eventTitle] ?? season;
        data = {
          competition: 'Event',
          round: null,
          stage: null,
          homeTeam: null,
          awayTeam: null,
          title: eventTitle,
          additionalInfo: title ? game.customText.trim() || null : null,
        };
      }
      const filters = {
        season: { key: season },
        competition: data.competition,
        round: data.round ?? { $null: true },
        stage: data.stage ?? { $null: true },
        homeTeam: data.homeTeam ?? { $null: true },
        awayTeam: data.awayTeam ?? { $null: true },
        title: data.title ?? { $null: true },
      };
      counter.add('match', await upsert('api::match.match', filters, { ...data, season: seasons[season], date: game.date || null }));
      match = await strapi.documents('api::match.match').findFirst({ filters });
      matches.push({ ...match, season: { key: season } });
    } else if (!match.date && game.date) {
      await strapi.documents('api::match.match').update({ documentId: match.documentId, data: { date: game.date } });
      match.date = game.date;
      counter.add('match date', 'updated');
    }
    return match;
  };

  // Videos
  const videosByUrl = new Map();
  for (const game of games) {
    const match = await matchOf(game);
    for (const [index, link] of game.links.entries()) {
      const scorer = (link.scorer || '').trim();
      const player = scorer ? playerOf(scorer) : null;
      if (scorer && !player && scorer !== 'Eigentor') report.push(`video ${link.link}: scorer "${scorer}" not linked to a player`);
      counter.add(
        'video',
        await upsert(
          'api::video.video',
          { url: link.link },
          {
            url: link.link,
            description: (link.description || '').trim() || null,
            player: player?.documentId ?? null,
            name: player ? null : scorer || null,
            match: match.documentId,
            order: index + 1,
          }
        )
      );
      videosByUrl.set(link.link, {
        documentId: (await strapi.documents('api::video.video').findFirst({ filters: { url: link.link } })).documentId,
        player,
        date: game.date,
        nominated: String(link.goalOfSeasonCandidate) === '1',
      });
    }
  }

  // Polls
  const upsertPoll = async (type, year, open) => {
    counter.add('poll', await upsert('api::poll.poll', { type, year }, { type, year, open, surveyUrl: SURVEY_LINKS[year] ?? null }));
    return (await strapi.documents('api::poll.poll').findFirst({ filters: { type, year } })).documentId;
  };
  const upsertOption = async (poll, { video = null, player = null, name = null, votes = 0 }) => {
    const filters = {
      poll: { documentId: poll },
      ...(video ? { video: { documentId: video } } : { video: { id: { $null: true } }, player: player ? { documentId: player } : { id: { $null: true } } }),
      ...(video || player ? {} : { name }),
    };
    counter.add('poll option', await upsert('api::poll-option.poll-option', filters, { poll, video, player, name, votes }));
  };

  // Tor des Jahres: one option per nominated goal; the votes per player go to the player's (first) goal.
  const nominated = [...videosByUrl.values()].filter((video) => video.nominated).sort((a, b) => a.date.localeCompare(b.date));
  const goalYears = [...new Set([...goalOptions.map((option) => option.season), ...nominated.map((video) => video.date.slice(0, 4))])].sort();
  for (const year of goalYears) {
    const poll = await upsertPoll('goalOfTheYear', year, year === goalYears[goalYears.length - 1]);
    const votes = new Map(goalOptions.filter((option) => option.season === year).map((option) => [option.player, toInt(option.votes) ?? 0]));
    for (const video of nominated.filter((candidate) => candidate.date.startsWith(year))) {
      const fullName = video.player ? `${video.player.firstName} ${video.player.lastName}` : null;
      const voteCount = fullName && votes.has(fullName) ? votes.get(fullName) : 0;
      if (fullName && votes.has(fullName)) votes.delete(fullName);
      else if (fullName && goalOptions.some((option) => option.season === year && option.player === fullName)) {
        report.push(`Tor des Jahres ${year}: ${fullName} has several nominated goals → votes counted for the first one`);
      }
      await upsertOption(poll, { video: video.documentId, player: video.player?.documentId ?? null, votes: voteCount });
    }
    // Options without a nominated video (legacy mismatch) stay as player options.
    for (const [fullName, voteCount] of votes) {
      const player = byFullName.get(fullName);
      report.push(`Tor des Jahres ${year}: ${fullName} has no nominated video → option without video`);
      await upsertOption(poll, { player: player?.documentId ?? null, name: player ? null : fullName, votes: voteCount });
    }
  }

  // Spieler der Saison: one option per player.
  const playerYears = [...new Set(playerOptions.map((option) => option.season))].sort();
  for (const year of playerYears) {
    const poll = await upsertPoll('playerOfTheYear', year, year === playerYears[playerYears.length - 1]);
    for (const option of playerOptions.filter((entry) => entry.season === year)) {
      const player = byFullName.get(option.player.trim());
      if (!player) report.push(`Spieler der Saison ${year}: "${option.player}" not linked to a player`);
      await upsertOption(poll, { player: player?.documentId ?? null, name: player ? null : option.player.trim(), votes: toInt(option.votes) ?? 0 });
    }
  }

  for (const type of ['video', 'poll', 'poll-option']) {
    await setPublicPermissions(type, ['find', 'findOne']);
  }
  counter.report();
  if (report.length) {
    console.log(`Check in the admin (${report.length}):`);
    report.forEach((line) => console.log(`  ${line}`));
  }
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
