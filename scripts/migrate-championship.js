'use strict';

/**
 * Migrates the championship data of the legacy PHP API into Strapi:
 *   seasons (`season`, with league and the notes the website had hard-coded),
 *   getStandings → `standing` (goal difference "56:10" split into numbers),
 *   getScorers → `scorer` (season table, players linked by "First Last"),
 *   getMatchInfo → `match` (label → competition/round/stage, free-text date → date + time,
 *   goal scorer text "Paschek (2), Jaindl" → `goals` with players linked by last name).
 *
 * Usage: node scripts/migrate-championship.js --exports <dir with the PHP JSON exports>
 * Run the club migration first (players). Safe to re-run: entries are matched and updated
 * (matches by season, competition, round, stage and teams).
 */

const path = require('path');
const { createCounter, parseArgs, readSource, runMigration, setPublicPermissions, upsert } = require('./lib/migrate-utils');

/** Notes that were hard-coded on the website per season. */
const SEASON_NOTES = {
  '2021-2022': {
    preface:
      'Die Plätze 1 bis 3 spielen am Ende der Saison in einem Play-off gegen die Plätze 5 bis 8 aus Liga A um den Aufstieg.',
  },
  '2022-2023': {
    postResults: '* Spiel wird offiziell nicht gewertet, da Gössnitz aus der Liga ausgestiegen ist.',
  },
};
const DEFAULT_LEAGUE = 'Liga B';

/** Last names in the goal scorer texts that belong to more than one player. */
const LAST_NAME_OVERRIDES = { Grundner: 'Christian Grundner' };

const toInt = (value) => {
  const number = parseInt(value, 10);
  return Number.isNaN(number) ? null : number;
};

/** "5. Runde", "Cup Achtelfinale", "Nachtragsspiel, 5. Runde", "Testspiel" → competition/round/stage. */
function parseLabel(label) {
  const text = (label || '').trim();
  let match;
  if (text === 'Testspiel') return { competition: 'Testspiel', round: null, stage: null };
  if ((match = /^(\d+)\. Runde$/.exec(text))) return { competition: 'Meisterschaft', round: Number(match[1]), stage: null };
  if ((match = /^(.+), (\d+)\. Runde$/.exec(text))) return { competition: 'Meisterschaft', round: Number(match[2]), stage: match[1] };
  if (text === 'Cup') return { competition: 'Cup', round: null, stage: null };
  if ((match = /^Cup (\d+)\. Runde$/.exec(text))) return { competition: 'Cup', round: Number(match[1]), stage: null };
  if ((match = /^Cup (.+)$/.exec(text))) return { competition: 'Cup', round: null, stage: match[1] };
  return null;
}

/** "SA, 19.09.2026, 15:30", "DI 19.05.2026, 19:00", "06.06.2026" → { date: "2026-09-19", time: "15:30:00.000" }. */
function parseDateTime(value) {
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/.exec(value || '');
  if (!match) return { date: null, time: null };
  const [, day, month, year, hours, minutes] = match;
  return {
    date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    time: hours ? `${hours.padStart(2, '0')}:${minutes}:00.000` : null,
  };
}

runMigration(async () => {
  const args = parseArgs(['exports']);
  const source = (endpoint) => readSource(path.join(args.exports, `${endpoint}.json`));
  const counter = createCounter();
  const report = [];

  const standings = await source('getStandings');
  const scorers = await source('getScorers');
  const matches = await source('getMatchInfo');

  // Seasons
  const keys = [...new Set([...standings, ...scorers, ...matches].map((entry) => entry.season))].sort();
  const seasons = {};
  for (const key of keys) {
    const notes = SEASON_NOTES[key] ?? {};
    counter.add(
      'season',
      await upsert('api::season.season', { key }, { key, league: DEFAULT_LEAGUE, preface: notes.preface ?? null, postResults: notes.postResults ?? null })
    );
    seasons[key] = (await strapi.documents('api::season.season').findFirst({ filters: { key } })).documentId;
  }

  // Players (from the club migration)
  const players = await strapi.documents('api::player.player').findMany({ limit: 1000 });
  const byFullName = new Map(players.map((player) => [`${player.firstName} ${player.lastName}`, player.documentId]));
  const byLastName = new Map();
  players.forEach((player) => byLastName.set(player.lastName, [...(byLastName.get(player.lastName) ?? []), player.documentId]));
  const playerByLastName = (lastName) => {
    if (LAST_NAME_OVERRIDES[lastName]) return byFullName.get(LAST_NAME_OVERRIDES[lastName]) ?? null;
    const found = byLastName.get(lastName) ?? [];
    return found.length === 1 ? found[0] : null;
  };

  for (const row of standings) {
    const [goalsFor, goalsAgainst] = (row.goalDifference || '').split(':').map(toInt);
    counter.add(
      'standing',
      await upsert(
        'api::standing.standing',
        { season: { key: row.season }, team: row.team.trim() },
        {
          season: seasons[row.season],
          place: toInt(row.place),
          team: row.team.trim(),
          games: toInt(row.games) ?? 0,
          wins: toInt(row.wins) ?? 0,
          draws: toInt(row.draws) ?? 0,
          losses: toInt(row.losses) ?? 0,
          goalsFor: goalsFor ?? 0,
          goalsAgainst: goalsAgainst ?? 0,
          points: toInt(row.points) ?? 0,
        }
      )
    );
  }

  for (const row of scorers) {
    const name = row.playerName.trim();
    const player = byFullName.get(name) ?? null;
    if (!player && name !== 'Eigentor') report.push(`season scorer without player: ${row.season} ${name}`);
    counter.add(
      'scorer',
      await upsert(
        'api::scorer.scorer',
        { season: { key: row.season }, name },
        { season: seasons[row.season], player, name, goals: toInt(row.goals) ?? 0 }
      )
    );
  }

  // Matches have no unique field: they are found by season, competition, round, stage and teams.
  // The same pairing can occur twice (two test matches in 2024-2025), so the nth occurrence in the
  // legacy list is matched with the nth existing entry (ordered by creation).
  const occurrences = new Map();
  const upsertMatch = async ({ seasonKey, ...data }) => {
    const filters = {
      season: { key: seasonKey },
      competition: data.competition,
      round: data.round ?? { $null: true },
      stage: data.stage ?? { $null: true },
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
    };
    const key = JSON.stringify(filters);
    const index = occurrences.get(key) ?? 0;
    occurrences.set(key, index + 1);
    const existing = await strapi.documents('api::match.match').findMany({ filters, sort: 'id:asc' });
    if (existing[index]) {
      await strapi.documents('api::match.match').update({ documentId: existing[index].documentId, data });
      return 'updated';
    }
    await strapi.documents('api::match.match').create({ data });
    return 'created';
  };

  for (const row of matches) {
    const label = parseLabel(row.matchInfo);
    if (!label) report.push(`unknown match label "${row.matchInfo}" (match ${row.id}) → stored as stage`);
    const { date, time } = parseDateTime(row.dateTime);
    const goals = (row.goalScorer || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [, name, count] = /^(.*?)(?:\s*\((\d+)\))?$/.exec(part);
        const player = playerByLastName(name);
        if (!player && name !== 'Eigentor') report.push(`match ${row.id}: goal scorer "${name}" not linked to a player`);
        return { player, name, count: count ? Number(count) : 1 };
      });
    counter.add(
      'match',
      await upsertMatch({
        seasonKey: row.season,
        season: seasons[row.season],
        ...(label ?? { competition: 'Meisterschaft', round: null, stage: (row.matchInfo || '').trim() || null }),
        // Dates missing in the PHP data may have been filled in by the video migration: keep them.
        ...(date ? { date } : {}),
        ...(time ? { time } : {}),
        venue: (row.venue || '').trim() || null,
        homeTeam: row.homeTeam.trim(),
        awayTeam: row.awayTeam.trim(),
        homeScore: toInt(row.homeScore),
        awayScore: toInt(row.awayScore),
        additionalInfo: (row.additionalInfo || '').trim() || null,
        goals,
      })
    );
  }

  for (const type of ['season', 'standing', 'scorer', 'match']) {
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
