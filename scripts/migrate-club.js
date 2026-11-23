'use strict';

/**
 * Migrates the club data of the legacy PHP API into Strapi:
 *   players (getPlayers/getSquadPlayers/getActivePlayers → `player` with squad Kader/Aktiv/Ehemalig),
 *   team page (`team-page`: squad and member lists "as of" dates), board (getChefs → `board-member`),
 *   members (getActive/Support/KidsMembership → `member`), Papp-Fans (getPappfans → `papp-fan`),
 *   match ball donations (getDonations → `donation`). Images go to the media library.
 *
 * Usage:
 *   node scripts/migrate-club.js --exports <dir with the PHP JSON exports> --images <hvtdp/src/assets/images>
 *     [--images-url https://www.hvtdpstainz.at/assets/images] [--squad-as-of 2025-12-01]
 *
 * Expects <endpoint>.json files in --exports (as written by hvtdp/scripts/migrate-to-strapi.sh).
 * Safe to re-run: entries are matched by name (and date/type) and updated.
 */

const path = require('path');
const {
  createCounter,
  createMediaUploader,
  parseArgs,
  readSource,
  runMigration,
  setPublicPermissions,
  setSingle,
  upsert,
} = require('./lib/migrate-utils');

const toInt = (value) => {
  const number = parseInt(value, 10);
  return Number.isNaN(number) ? null : number;
};

/** "01.07.2024" → "2024-07-01" (null for anything else). */
const germanDateToIso = (value) => {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((value || '').trim());
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : null;
};

const nameKey = (entry) => `${entry.firstName.trim()}|${entry.lastName.trim()}`;

/** Former players the PHP player list does not contain, but who scored in the goal videos. */
const EXTRA_PLAYERS = [
  { firstName: 'Florian', lastName: 'Schriebl', imagePath: 'team/Schriebl.JPG' },
  { firstName: 'Herbert', lastName: 'Kohlberger', imagePath: 'team/Kohlberger.JPG' },
  { firstName: 'Markus', lastName: 'Sackl', imagePath: 'team/Sackl.JPG' },
];

runMigration(async () => {
  const args = parseArgs(['exports', 'images'], ['images-url', 'squad-as-of']);
  const source = (endpoint) => readSource(path.join(args.exports, `${endpoint}.json`));
  const media = createMediaUploader({ images: args.images, imagesUrl: args['images-url'] });
  const counter = createCounter();

  // Players: every player once, squad status from the squad/active lists.
  const squad = new Set((await source('getSquadPlayers')).map(nameKey));
  const active = new Set((await source('getActivePlayers')).map(nameKey));
  for (const player of await source('getPlayers')) {
    const key = nameKey(player);
    const label = `player ${key}`;
    const image = await media.get(player.imagePath, label, `${player.firstName} ${player.lastName}`);
    const result = await upsert(
      'api::player.player',
      { firstName: player.firstName.trim(), lastName: player.lastName.trim() },
      {
        firstName: player.firstName.trim(),
        lastName: player.lastName.trim(),
        position: player.position || null,
        squad: squad.has(key) ? 'Kader' : active.has(key) ? 'Aktiv' : 'Ehemalig',
        memberSinceYear: toInt(player.memberSinceYear),
        games: toInt(player.games) ?? 0,
        goals: toInt(player.goals) ?? 0,
        image: image ? image.id : null,
      }
    );
    counter.add('player', result);
  }
  for (const { imagePath, ...player } of EXTRA_PLAYERS) {
    const image = await media.get(imagePath, `player ${player.firstName}|${player.lastName}`, `${player.firstName} ${player.lastName}`);
    counter.add('player', await upsert('api::player.player', player, { ...player, squad: 'Ehemalig', image: image ? image.id : null }));
  }

  // The squad list date was shown as a fixed "Stand 12/2025" so far.
  const squadAsOf = args['squad-as-of'] || '2025-12-01';

  // "Dummy" entries were placeholders that aligned the old website's grid.
  const chefs = (await source('getChefs')).filter((chef) => chef.firstName.trim() !== 'Dummy');
  for (const [index, chef] of chefs.entries()) {
    const image = await media.get(chef.imagePath, `board ${nameKey(chef)}`, `${chef.firstName} ${chef.lastName}`);
    const result = await upsert(
      'api::board-member.board-member',
      { firstName: chef.firstName.trim(), lastName: chef.lastName.trim() },
      {
        function: chef.function.trim(),
        firstName: chef.firstName.trim(),
        lastName: chef.lastName.trim(),
        order: index + 1,
        image: image ? image.id : null,
      }
    );
    counter.add('board-member', result);
  }

  // Members; each list is "as of" the newest legacy date of its members (shown per group on the website).
  const membersAsOf = {};
  for (const [endpoint, type, asOfField] of [
    ['getActiveMembership', 'Aktiv', 'activeMembersAsOf'],
    ['getSupportMembership', 'Fördernd', 'supportingMembersAsOf'],
    ['getKidsMembership', 'Kids', 'kidsMembersAsOf'],
  ]) {
    const members = await source(endpoint);
    membersAsOf[asOfField] = members.map((member) => germanDateToIso(member.per)).filter(Boolean).sort().pop() ?? null;
    for (const member of members) {
      const result = await upsert(
        'api::member.member',
        { firstName: member.firstName.trim(), lastName: member.lastName.trim(), type },
        {
          firstName: member.firstName.trim(),
          lastName: member.lastName.trim(),
          type,
        }
      );
      counter.add('member', result);
    }
  }

  await setSingle('api::team-page.team-page', { squadAsOf, ...membersAsOf });

  const fans = [...(await source('getPappfans'))].sort((a, b) => toInt(a.id) - toInt(b.id));
  for (const [index, fan] of fans.entries()) {
    const image = await media.get(fan.imagePath, `papp-fan ${fan.name}`, fan.name);
    const result = await upsert(
      'api::papp-fan.papp-fan',
      { name: fan.name.trim() },
      { name: fan.name.trim(), order: index + 1, image: image ? image.id : null }
    );
    counter.add('papp-fan', result);
  }

  for (const donation of await source('getDonations')) {
    const label = `donation ${donation.donator} ${donation.date}`;
    const image = await media.get(donation.imagePath, label, `Ballübergabe ${donation.donator}`);
    const ball = await media.get(donation.matchBallImagePath, label, `Matchball ${donation.donator}`);
    const result = await upsert(
      'api::donation.donation',
      { donator: donation.donator.trim(), date: donation.date },
      {
        donator: donation.donator.trim(),
        date: donation.date,
        game: (donation.game || '').trim() || null,
        description: (donation.description || '').trim() || null,
        image: image ? image.id : null,
        matchBallImage: ball ? ball.id : null,
      }
    );
    counter.add('donation', result);
  }

  for (const type of ['player', 'board-member', 'member', 'papp-fan', 'donation']) {
    await setPublicPermissions(type, ['find', 'findOne']);
  }
  await setPublicPermissions('team-page', ['find']);

  counter.report();
  await media.report();
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
