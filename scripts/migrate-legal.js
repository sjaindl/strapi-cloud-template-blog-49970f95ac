'use strict';

/**
 * Creates the legal pages (`legal-page`): Impressum and Datenschutzerklärung as Markdown drafts that describe what
 * the website actually does. Club data the drafts cannot know is marked as [[placeholder]]; the website highlights
 * placeholders until they are replaced in the admin. The drafts are not legal advice — review them before going
 * live.
 *
 * Usage: node scripts/migrate-legal.js [--force true]
 * Existing pages are kept (edits in the admin win); `--force true` overwrites them with the drafts.
 */

const { createCounter, parseArgs, runMigration, setPublicPermissions, upsert } = require('./lib/migrate-utils');

const CLUB_MAIL = 'hvtdpstainz@gmx.at';
const CLUB_PHONE = '+43 664 4310021';
const CLUB_ADDRESS = 'Engelweingartenstraße 12d/14';
/** Name and purpose as in the statutes (§ 1, § 2). */
const CLUB_NAME = 'Hobbyverein (HV) Textildruckprofi (TDP) Stainz';
const CLUB_PURPOSE =
  'Der Verein ist gemeinnützig und dient der Förderung des Hobbyfußballs. Durch regelmäßiges Training und das Abhalten von Freundschaftsspielen wird nicht nur das Miteinander gefördert, sondern jeder Hobbysportler kann sich sportlich verbessern und messen. Der Verein sorgt außerdem für die Zusammenkunft verschiedener Altersgruppen, Herkünfte und Geschlechter, um gemeinsam das gleiche Hobby in der Freizeit ausüben zu können. Seine Tätigkeit ist nicht auf Gewinn ausgerichtet.';

const impressum = (board) =>
  [
    '## Medieninhaber und Herausgeber',
    `${CLUB_NAME} (kurz: HV TDP Stainz)  \n${CLUB_ADDRESS}  \n8510 Stainz, Österreich`,
    `**ZVR-Zahl:** 1522039338  \n**Vereinssitz:** Stainz  \n**Zuständige Vereinsbehörde:** Bezirkshauptmannschaft Deutschlandsberg`,
    `**E-Mail:** [${CLUB_MAIL}](mailto:${CLUB_MAIL})  \n**Telefon:** ${CLUB_PHONE}`,
    '## Vertretungsbefugt',
    board.find((member) => /^Obmann$/i.test(member.function))
      ? `${board.find((member) => /^Obmann$/i.test(member.function)).name} (Obmann)`
      : '[[Name des Obmanns]] (Obmann)',
    '## Offenlegung gemäß § 25 Mediengesetz',
    `**Vereinszweck (laut Statuten):** ${CLUB_PURPOSE}`,
    '**Vorstand:**',
    board.length ? board.map((member) => `- ${member.function}: ${member.name}`).join('\n') : '- [[Vorstand]]',
    '**Grundlegende Richtung (Blattlinie):** Information über den Verein HV TDP Stainz, seine Spiele, Veranstaltungen und das Vereinsleben.',
    '## Haftung für Inhalte und Links',
    'Die Inhalte dieser Website wurden mit größter Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität können wir jedoch keine Gewähr übernehmen. Für Inhalte verlinkter externer Websites sind ausschließlich deren Betreiber verantwortlich; zum Zeitpunkt der Verlinkung waren keine Rechtsverstöße erkennbar.',
    '## Urheberrecht',
    'Texte, Fotos und Videos auf dieser Website sind urheberrechtlich geschützt. Eine Verwendung ist nur mit Zustimmung des Vereins erlaubt.',
    '## Website',
    'Konzeption und Umsetzung: Stefan Jaindl',
  ].join('\n\n');

const datenschutz = () =>
  [
    'Der Schutz deiner persönlichen Daten ist uns ein Anliegen. Wir verarbeiten deine Daten ausschließlich auf Grundlage der gesetzlichen Bestimmungen (DSGVO, DSG, TKG 2021). In dieser Erklärung informieren wir dich über die wichtigsten Aspekte der Datenverarbeitung auf unserer Website.',
    '## Verantwortlicher',
    `${CLUB_NAME} (HV TDP Stainz), ${CLUB_ADDRESS}, 8510 Stainz  \nE-Mail: [${CLUB_MAIL}](mailto:${CLUB_MAIL}), Telefon: ${CLUB_PHONE}`,
    '## Hosting und Server-Logfiles',
    'Unsere Website, unser Redaktionssystem (cms.hvtdpstainz.at) und unser Chatbot laufen auf einem Server von Hostinger International Ltd. (Larnaca, Zypern) mit Standort in Frankfurt am Main, Deutschland. Beim Aufruf speichert der Server technisch notwendige Daten (IP-Adresse, Datum und Uhrzeit, aufgerufene Seite, Browser) in Logfiles, um den Betrieb und die Sicherheit zu gewährleisten. Rechtsgrundlage ist unser berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO).',
    'Fotos, Videos, Dokumente und Schriftarten liegen auf diesem Server; es werden dafür keine Daten an Dritte übermittelt.',
    '## Anmeldungen und Bestellungen',
    'Wenn du dich über ein Formular zu einer Veranstaltung anmeldest (z. B. Hallenturnier, Torschuss Challenge, Turniere) oder Enten für das Entenrennen bestellst, speichern wir die Angaben aus dem Formular (Name, E-Mail, ggf. Telefonnummer, Mannschaftsname, Adresse, Anzahl, Foto bei der Torschuss Challenge). Wir verwenden sie zur Abwicklung der Anmeldung bzw. Bestellung: Der Verein erhält eine E-Mail mit deinen Angaben, du erhältst eine Bestätigung per E-Mail. Rechtsgrundlage ist die Vertragserfüllung bzw. die Durchführung vorvertraglicher Maßnahmen (Art. 6 Abs. 1 lit. b DSGVO).',
    'Bei der Torschuss Challenge erscheinen Name und Foto im öffentlichen Voting; Kontaktdaten werden nicht veröffentlicht.',
    '## Votings',
    'Bei unseren Votings (Tor des Jahres, Spieler der Saison, Torschuss Challenge) speichern wir nur die Stimme, nicht wer abgestimmt hat. Damit pro Stunde nur einmal abgestimmt wird, setzen wir ein Cookie für eine Stunde und halten die IP-Adresse kurzzeitig (höchstens eine Stunde) im Arbeitsspeicher des Servers, um Mehrfachabstimmungen zu begrenzen. Sie wird nicht dauerhaft gespeichert.',
    '## Kontakt',
    'Das Kontaktformular öffnet dein E-Mail-Programm; die Nachricht wird erst gesendet, wenn du sie dort abschickst. Deine Angaben verwenden wir nur zur Bearbeitung deiner Anfrage.',
    '## Cookies und lokale Speicherung',
    '- **cookieconsent_status:** speichert deine Cookie-Auswahl (1 Jahr, technisch notwendig).',
    '- **Voting-Cookies** (z. B. goal_of_season_voted): verhindern mehrfaches Abstimmen innerhalb einer Stunde (technisch notwendig).',
    '- **Lokaler Speicher:** merkt sich, dass du einen Hinweisbalken geschlossen hast.',
    '- **Google Analytics** (_ga, _ga_*): nur nach deiner Zustimmung, siehe unten.',
    'Du kannst Cookies in deinem Browser jederzeit löschen.',
    '## Google Analytics',
    'Nur wenn du im Cookie-Hinweis „Alle akzeptieren“ wählst, verwenden wir Google Analytics 4 der Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland, um die Nutzung unserer Website anonymisiert auszuwerten. Dabei werden Cookies gesetzt und Nutzungsdaten (z. B. aufgerufene Seiten, Gerät, ungefährer Standort) an Google übermittelt; eine Übermittlung in die USA ist möglich (Google ist nach dem EU-US Data Privacy Framework zertifiziert). Rechtsgrundlage ist deine Einwilligung (Art. 6 Abs. 1 lit. a DSGVO). Du kannst sie jederzeit widerrufen, indem du deine Cookies löscht und im Cookie-Hinweis „Nur notwendige“ wählst.',
    '## YouTube-Videos',
    'Videos sind über den erweiterten Datenschutzmodus von YouTube (youtube-nocookie.com, Google Ireland Limited) eingebunden. Vor dem Abspielen zeigen wir nur ein Vorschaubild; erst wenn du auf „Abspielen“ tippst, wird das Video von YouTube geladen und dabei unter anderem deine IP-Adresse an Google übermittelt.',
    '## Google Maps',
    'Auf der Kontaktseite zeigen wir eine Karte von Google Maps (Google Ireland Limited) erst, wenn du auf „Karte laden“ tippst. Dann werden Daten wie deine IP-Adresse an Google übermittelt. Rechtsgrundlage ist deine Einwilligung durch den Klick (Art. 6 Abs. 1 lit. a DSGVO).',
    '## Chatbot',
    'Unser Chatbot (Flowise) läuft auf unserem eigenen Server (siehe Hosting). Wenn du eine Frage stellst, wird deine Eingabe zur Beantwortung an OpenRouter, Inc. (USA) übermittelt, das sie an das jeweilige KI-Sprachmodell weiterleitet; dabei kann eine Übermittlung in die USA und an weitere KI-Anbieter erfolgen. Rechtsgrundlage ist deine Einwilligung durch die Nutzung des Chats (Art. 6 Abs. 1 lit. a DSGVO). Bitte gib im Chat keine sensiblen persönlichen Daten ein.',
    '## Umfragen',
    'Auf der Seite „Umfragen“ binden wir Umfragen von SurveyHero (enuvo GmbH, Schweiz) ein; die Skripte von SurveyHero werden nur auf dieser Seite geladen, dabei wird deine IP-Adresse an SurveyHero übermittelt. Die Teilnahme ist freiwillig; es gelten die Datenschutzbestimmungen von SurveyHero.',
    '## Links zu sozialen Netzwerken',
    'Facebook, Instagram und WhatsApp sind nur verlinkt. Daten werden erst übertragen, wenn du einem Link folgst.',
    '## Deine Rechte',
    `Dir stehen die Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) sowie auf Widerruf einer Einwilligung zu. Wende dich dazu an [${CLUB_MAIL}](mailto:${CLUB_MAIL}). Wenn du glaubst, dass die Verarbeitung deiner Daten gegen das Datenschutzrecht verstößt, kannst du dich bei der Österreichischen Datenschutzbehörde (www.dsb.gv.at) beschweren.`,
  ].join('\n\n');

runMigration(async () => {
  const args = parseArgs([], ['force']);
  const force = args.force === 'true';
  const counter = createCounter();

  const board = (await strapi.documents('api::board-member.board-member').findMany({ sort: 'order:asc', limit: 100 })).map((member) => ({
    function: member.function,
    name: `${member.firstName} ${member.lastName}`,
  }));
  const pages = [
    { slug: 'impressum', title: 'Impressum', content: impressum(board) },
    { slug: 'datenschutz', title: 'Datenschutzerklärung', content: datenschutz() },
  ];

  const placeholders = new Set();
  for (const page of pages) {
    const existing = await strapi.documents('api::legal-page.legal-page').findFirst({ filters: { slug: page.slug } });
    if (existing && !force) {
      console.log(`${page.slug}: exists → kept (use --force true to overwrite with the draft)`);
      (existing.content ?? '').match(/\[\[[^\]]+\]\]/g)?.forEach((placeholder) => placeholders.add(`${page.slug}: ${placeholder}`));
      continue;
    }
    counter.add('legal-page', await upsert('api::legal-page.legal-page', { slug: page.slug }, { ...page, effectiveDate: new Date().toISOString().slice(0, 10) }));
    page.content.match(/\[\[[^\]]+\]\]/g)?.forEach((placeholder) => placeholders.add(`${page.slug}: ${placeholder}`));
  }

  await setPublicPermissions('legal-page', ['find', 'findOne']);
  counter.report();
  if (placeholders.size) {
    console.log(`Placeholders to fill in in the admin before going live (${placeholders.size}):`);
    placeholders.forEach((placeholder) => console.log(`  ${placeholder}`));
  }
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
