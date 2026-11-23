'use strict';

/**
 * Gives the news items a category (Spielbericht, Turnier, Veranstaltung, Vereinsleben) derived from their title
 * and links match reports to their championship `match` (season from the news date, opponent and round/stage
 * from the title, home/away from the order of the teams).
 *
 * Usage: node scripts/migrate-news-categories.js [--force true]
 * Run after the news and championship/videos migrations. Only fills in missing categories and match links, so
 * changes made in the admin are kept on re-runs; `--force true` recomputes everything.
 */

const { createCounter, parseArgs, runMigration } = require('./lib/migrate-utils');

const UID = 'api::news-item.news-item';
const OWN_TEAM = 'HV TDP Stainz';

/** First matching rule wins (title in lower case). */
const CATEGORY_RULES = [
  ['Veranstaltung', /entenrennen|stadionfest|comedy|verlosung|laufteam|torschuss/],
  ['Turnier', /turnier|kegel|boccia|darts|schnaps|stra(ß|ss)enstock|killerball/],
  ['Spielbericht', /runde|spielb?e?richt|spielericht|cup|testspiel|allstars| : |punkte|niederlage|sieg|serienmeister|fußballjahr|heimspielauftakt|sommerpause/],
];
const categoryOf = (title) => (CATEGORY_RULES.find(([, rule]) => rule.test(title.toLowerCase())) ?? ['Vereinsleben'])[0];

/** "2026-10-24" → "2026-2027" (seasons start in August). */
const seasonOf = (date) => {
  const [year, month] = date.split('-').map(Number);
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
};

const normalize = (text) =>
  (text || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9äöü ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Words of a team name that identify it ("STT Pichler" → ["pichler"]; club prefixes and short words left out). */
const PREFIXES = new Set(['hfc', 'stt', 'sk', 'fc', 'sv', 'gsv', 'spg', 'fk', 'hc', 'su', 'svu', 'esv', 'ob', 'st', 'o', 'pl']);
const keyWords = (team) => normalize(team).split(' ').filter((word) => word.length > 2 && !PREFIXES.has(word));

/** Position of the team in the title (-1 if none of its key words appears). */
const positionIn = (title, team) => {
  const positions = keyWords(team)
    .map((word) => title.indexOf(word))
    .filter((index) => index >= 0);
  return positions.length ? Math.min(...positions) : -1;
};

/** Keeps the candidates that fulfil the condition, unless none would be left (titles are not always exact). */
const narrow = (candidates, condition) => {
  const narrowed = candidates.filter(condition);
  return narrowed.length ? narrowed : candidates;
};

const daysBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

/** The match a report is about, or null if it is not clear. */
function findMatch(news, matches) {
  const title = normalize(news.title);
  // July belongs to either season (season finale or summer friendlies).
  const seasons = [seasonOf(news.date), ...(news.date.slice(5, 7) === '07' ? [seasonOf(`${news.date.slice(0, 4)}-08-01`)] : [])];
  const round = /(\d+)\s*runde/.exec(title)?.[1];
  const competition = /testspiel|allstars/.test(title) ? 'Testspiel' : /cup/.test(title) ? 'Cup' : round ? 'Meisterschaft' : null;

  let candidates = matches.filter((match) => {
    if (!seasons.includes(match.season?.key) || match.competition === 'Event') return false;
    // A dated match more than two weeks away from the report is a different one.
    if (match.date && daysBetween(match.date, news.date) > 14) return false;
    if (competition && match.competition !== competition) return false;
    const opponent = match.homeTeam === OWN_TEAM ? match.awayTeam : match.homeTeam;
    if (positionIn(title, opponent) < 0) return false;
    // Home team first in the title.
    const own = title.indexOf('hv tdp stainz');
    if (own >= 0 && own < positionIn(title, opponent) !== (match.homeTeam === OWN_TEAM)) return false;
    return true;
  });
  if (round) candidates = narrow(candidates, (match) => match.round === Number(round));
  const stage = ['achtelfinale', 'viertelfinale', 'halbfinale', 'finale'].find((word) => title.includes(word));
  if (stage) candidates = narrow(candidates, (match) => normalize(match.stage) === stage);
  if (candidates.length > 1) {
    // The match closest to the report date (within two weeks).
    const dated = candidates
      .filter((match) => match.date && daysBetween(match.date, news.date) <= 14)
      .sort((a, b) => daysBetween(a.date, news.date) - daysBetween(b.date, news.date));
    if (dated.length) candidates = [dated[0]];
  }
  return candidates.length === 1 ? candidates[0] : null;
}

runMigration(async () => {
  const args = parseArgs([], ['force']);
  const force = args.force === 'true';
  const counter = createCounter();
  const unlinked = [];

  const matches = await strapi.documents('api::match.match').findMany({ limit: 5000, populate: { season: { fields: ['key'] } } });
  const news = await strapi.documents(UID).findMany({ status: 'published', limit: 5000, populate: { match: { fields: ['id'] } } });

  for (const item of news) {
    const data = {};
    if (force || !item.category) data.category = categoryOf(item.title);
    const category = data.category ?? item.category;
    if (category === 'Spielbericht' && (force || !item.match)) {
      const match = findMatch(item, matches);
      if (match) data.match = match.documentId;
      else if (item.date >= '2021-08-01') unlinked.push(`${item.date} ${item.title}`);
      // Recomputing also removes links that no longer hold.
      if (!match && force && item.match) data.match = null;
    } else if (force && item.match && category !== 'Spielbericht') {
      data.match = null;
    }
    if (!Object.keys(data).length) continue;
    await strapi.documents(UID).update({ documentId: item.documentId, data, status: 'published' });
    if (data.category) counter.add(`category ${data.category}`, 'updated');
    if (data.match) counter.add('match link', 'updated');
    if (data.match === null) counter.add('match link removed', 'updated');
  }

  counter.report();
  if (unlinked.length) {
    console.log(`Match reports without a clear match (${unlinked.length}, link them in the admin if needed):`);
    unlinked.forEach((line) => console.log(`  ${line}`));
  }
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
