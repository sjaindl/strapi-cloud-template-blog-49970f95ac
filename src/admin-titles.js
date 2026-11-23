'use strict';

/**
 * Readable titles for the admin. Relations and the relation picker show the target's main field; for matches,
 * videos or voting options no single field says what an entry is ("untitled", a YouTube URL, "2026"). These
 * types get a computed, read-only `adminTitle` (private, not in the public API) that is their main field.
 *
 * Titles are refreshed after every create/update through the Document Service (admin, REST, migration
 * scripts), including entries whose title shows the changed one (a match's videos and their voting options).
 * Entries without a title are filled in at startup.
 */

const OWN_TEAM = 'HV TDP Stainz';

/** "2024-2025" → "2024/25" */
const season = (entry) => {
  const key = entry?.key ?? '';
  const match = /^(\d{4})-\d{2}(\d{2})$/.exec(key);
  return match ? `${match[1]}/${match[2]}` : key;
};

/** "2026-09-12" → "12.09.2026" */
const date = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
};

const fullName = (player) => (player ? `${player.firstName} ${player.lastName}` : null);
const join = (parts, separator = ' · ') => parts.filter(Boolean).join(separator);
const withDate = (text, value) => (date(value) ? `${text} (${date(value)})` : text);

/** Same labels as the website ("5. Runde", "Nachtragsspiel, 5. Runde", "Cup Achtelfinale", "Testspiel"). */
function matchLabel(match) {
  const round = match.round ? `${match.round}. Runde` : '';
  if (match.competition === 'Cup') return join(['Cup', round, match.stage], ' ');
  if (match.competition === 'Testspiel') return join(['Testspiel', match.stage], ' ');
  return join([match.stage, round], ', ') || 'Meisterschaft';
}

/** "HV TDP Stainz – STT Pichler (12.09.2026)", or the event title. */
function shortMatch(match) {
  if (!match) return '';
  return withDate(match.competition === 'Event' ? match.title : `${match.homeTeam} – ${match.awayTeam}`, match.date);
}

const POLL_NAMES = { goalOfTheYear: 'Tor des Jahres', playerOfTheYear: 'Spieler der Saison', goldenShot: 'Torschuss Challenge' };
const pollTitle = (poll) => (poll ? `${POLL_NAMES[poll.type] ?? poll.type} ${poll.year}` : '');

const TYPES = {
  'api::season.season': { populate: {}, title: () => null },
  'api::player.player': {
    populate: {},
    title: (player) => `${fullName(player)}${player.squad === 'Ehemalig' ? ' (ehemalig)' : ''}`,
  },
  // "2024/25 · 14. Runde · SK Hohenburg – HV TDP Stainz 5:3 (28.06.2025)", events "2021/22 · 1. Entenrennen Stainz (16.09.2021)"
  'api::match.match': {
    populate: { season: true },
    title: (match) => {
      if (match.competition === 'Event') return withDate(join([season(match.season), match.title]), match.date);
      const score = match.homeScore !== null && match.awayScore !== null ? ` ${match.homeScore}:${match.awayScore}` : '';
      return withDate(join([season(match.season), matchLabel(match), `${match.homeTeam} – ${match.awayTeam}${score}`]), match.date);
    },
  },
  // "2:0 Stefan Jaindl · HV TDP Stainz – STT Pichler (12.09.2026)", without scorer "Highlight · 1. Entenrennen Stainz"
  'api::video.video': {
    populate: { player: true, match: true },
    title: (video) => {
      const scorer = fullName(video.player) ?? video.name;
      const text = scorer ? join([video.description, scorer], ' ') : video.description && !/^\d+:\d+$/.test(video.description) ? video.description : 'Highlight';
      return join([text, shortMatch(video.match)]);
    },
  },
  'api::poll.poll': { populate: {}, title: pollTitle },
  // "Tor des Jahres 2026 · Stefan Jaindl (2:0 gegen STT Pichler)", "Spieler der Saison 2026 · Noah Dudek"
  'api::poll-option.poll-option': {
    populate: { poll: true, player: true, video: { populate: { match: true } } },
    title: (option) => {
      const name = fullName(option.player) ?? option.name ?? (option.video ? 'Highlight' : '');
      const match = option.video?.match;
      const opponent = match && (match.competition === 'Event' ? match.title : match.homeTeam === OWN_TEAM ? match.awayTeam : match.homeTeam);
      const goal = option.video ? join([option.video.description, opponent && `gegen ${opponent}`], ' ') : '';
      return join([pollTitle(option.poll), goal ? `${name} (${goal})` : name]);
    },
  },
  'api::standing.standing': {
    populate: { season: true },
    title: (row) => join([season(row.season), `${row.place}. ${row.team}`]),
  },
  // "2026 · 4. Boccia Turnier (22.08.2026)"
  'api::album.album': {
    populate: {},
    title: (album) => withDate(join([album.year, album.name]), album.date),
  },
  // "Adventkalender 2023 · Tor-Adventkalender"
  'api::advent-calendar.advent-calendar': {
    populate: {},
    title: (calendar) => join([`Adventkalender ${calendar.year}`, calendar.title]),
  },
  'api::scorer.scorer': {
    populate: { season: true, player: true },
    title: (scorer) => join([season(scorer.season), `${fullName(scorer.player) ?? scorer.name} (${scorer.goals} ${scorer.goals === 1 ? 'Tor' : 'Tore'})`]),
  },
};

/** Entries whose title contains the given entry: uid → [dependent uid, relation field]. */
const DEPENDENTS = {
  'api::season.season': [
    ['api::match.match', 'season'],
    ['api::standing.standing', 'season'],
    ['api::scorer.scorer', 'season'],
  ],
  'api::player.player': [
    ['api::video.video', 'player'],
    ['api::poll-option.poll-option', 'player'],
    ['api::scorer.scorer', 'player'],
  ],
  'api::match.match': [['api::video.video', 'match']],
  'api::video.video': [['api::poll-option.poll-option', 'video']],
  'api::poll.poll': [['api::poll-option.poll-option', 'poll']],
};

/** UIDs with an `adminTitle` field (season only cascades: its key is readable as is). */
const TITLED = Object.keys(TYPES).filter((uid) => uid !== 'api::season.season');

/** Recomputes the titles of the given entries (and, with `cascade`, of the entries that show them). */
async function refresh(strapi, uid, documentIds, { cascade = true } = {}) {
  if (!documentIds.length) return;
  if (TITLED.includes(uid)) {
    const entries = await strapi.documents(uid).findMany({
      filters: { documentId: { $in: documentIds } },
      populate: TYPES[uid].populate,
      limit: documentIds.length,
    });
    for (const entry of entries) {
      const adminTitle = (TYPES[uid].title(entry) || '').slice(0, 255) || null;
      if (adminTitle !== entry.adminTitle) {
        // Database query: bypasses the Document Service middleware below (no recursion).
        await strapi.db.query(uid).updateMany({ where: { documentId: entry.documentId }, data: { adminTitle } });
      }
    }
  }
  if (!cascade) return;
  for (const [dependent, field] of DEPENDENTS[uid] ?? []) {
    const rows = await strapi.db.query(dependent).findMany({
      select: ['documentId'],
      where: { [field]: { documentId: { $in: documentIds } } },
    });
    await refresh(strapi, dependent, [...new Set(rows.map((row) => row.documentId))]);
  }
}

/** Document Service middleware: refreshes the titles after an entry was created or updated. */
function middleware(strapi) {
  return async (context, next) => {
    const result = await next();
    if (TYPES[context.uid] && (context.action === 'create' || context.action === 'update') && result?.documentId) {
      await refresh(strapi, context.uid, [result.documentId]);
    }
    return result;
  };
}

/** Admin labels of fields whose technical name says little. */
const FIELD_LABELS = {
  'api::player.player': { squad: 'Kader-Status' },
  'api::team-page.team-page': {
    squadAsOf: 'Stand Kader',
    activeMembersAsOf: 'Stand aktive Mitglieder',
    supportingMembersAsOf: 'Stand fördernde Mitglieder',
    kidsMembersAsOf: 'Stand Kids Corner',
  },
};

/** Startup: `adminTitle` as main field (read-only, first list column) and titles for entries without one. */
async function setup(strapi) {
  for (const uid of TITLED) {
    const store = strapi.store({ type: 'plugin', name: 'content_manager_configuration', key: `content_types::${uid}` });
    const config = await store.get();
    if (config?.metadatas?.adminTitle) {
      config.settings = { ...config.settings, mainField: 'adminTitle', defaultSortBy: 'adminTitle', defaultSortOrder: 'ASC' };
      config.metadatas.adminTitle = {
        edit: { ...config.metadatas.adminTitle.edit, label: 'Titel', description: 'Wird automatisch erzeugt.', editable: false },
        list: { ...config.metadatas.adminTitle.list, label: 'Titel', searchable: true, sortable: true },
      };
      config.layouts.list = ['adminTitle', ...config.layouts.list.filter((field) => field !== 'adminTitle' && field !== 'id')].slice(0, 4);
      await store.set({ value: config });
    }

    const missing = await strapi.db.query(uid).findMany({ select: ['documentId'], where: { adminTitle: { $null: true } } });
    await refresh(strapi, uid, missing.map((row) => row.documentId), { cascade: false });
  }

  for (const [uid, labels] of Object.entries(FIELD_LABELS)) {
    const store = strapi.store({ type: 'plugin', name: 'content_manager_configuration', key: `content_types::${uid}` });
    const config = await store.get();
    if (!config?.metadatas) continue;
    for (const [field, label] of Object.entries(labels)) {
      const metadata = config.metadatas[field];
      if (metadata) {
        metadata.edit = { ...metadata.edit, label };
        metadata.list = { ...metadata.list, label };
      }
    }
    await store.set({ value: config });
  }

  // Each relation also stores the field it displays in the configuration of the type (or component) it belongs to.
  const owners = [
    ...Object.entries(strapi.contentTypes).map(([uid, schema]) => [`content_types::${uid}`, schema]),
    ...Object.entries(strapi.components).map(([uid, schema]) => [`components::${uid}`, schema]),
  ];
  for (const [key, schema] of owners) {
    const relations = Object.entries(schema.attributes).filter(([, attribute]) => attribute.type === 'relation' && TITLED.includes(attribute.target));
    if (!relations.length) continue;
    const store = strapi.store({ type: 'plugin', name: 'content_manager_configuration', key });
    const config = await store.get();
    let changed = false;
    for (const [name] of relations) {
      const edit = config?.metadatas?.[name]?.edit;
      if (edit && edit.mainField !== 'adminTitle') {
        edit.mainField = 'adminTitle';
        changed = true;
      }
    }
    if (changed) await store.set({ value: config });
  }
}

module.exports = { middleware, setup, refresh };
