import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type ResultEntry = {
  placing: number | null;
  name: string;
  time: string;
  eliminationRound: string | null;
};

type CupResultFile = {
  nr: number;
  map: string;
  author: string;
  fastestTime: string | null;
  fastestTimeDriver: string | null;
  fastestTimeRound: string | null;
  sourceFile: string;
  results: ResultEntry[];
};

type AliasList = Record<string, string[]>;

type AliasResolver = {
  canonicalByName: Map<string, string>;
  aliasesByCanonical: Map<string, string[]>;
};

type EventRecord = CupResultFile & {
  jsonFileName: string;
  htmlFileName: string;
  podium: Array<{ placing: number; entries: ResultEntry[] }>;
  authors: string[];
};

type DriverRecord = {
  canonicalName: string;
  htmlFileName: string;
  aliases: string[];
  fastestTimes: number;
  results: DriverResultRecord[];
};

type AuthorRecord = {
  canonicalName: string;
  htmlFileName: string;
  aliases: string[];
  tracks: EventRecord[];
};

type DriverResultRecord = {
  eventRecord: EventRecord;
  result: ResultEntry;
};

type DriverTimelineRecord = {
  eventRecord: EventRecord;
  result: ResultEntry | null;
};

type DriverStats = {
  starts: number;
  wins: number;
  podiums: number;
  bestFinish: number | null;
  fastestTimes: number;
};

type AuthorStats = {
  tracks: number;
  soloTracks: number;
  coAuthoredTracks: number;
  firstEvent: number | null;
  latestEvent: number | null;
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "results");
const outputDirectory = path.join(projectRoot, "html");
const eventsDirectory = path.join(outputDirectory, "events");
const driversDirectory = path.join(outputDirectory, "drivers");
const authorsDirectory = path.join(outputDirectory, "authors");
const indexFilePath = path.join(outputDirectory, "index.html");
const driverIndexFilePath = path.join(driversDirectory, "index.html");
const manualAliasListPath = path.join(
  projectRoot,
  "data",
  "player-aliases.json",
);
const generatedAliasListPath = path.join(
  projectRoot,
  "data",
  "player-aliases.generated.json",
);

async function main(): Promise<void> {
  const aliasResolver = await loadAliasResolver();
  const eventRecords = await loadEventRecords();
  const driverRecords = buildDriverRecords(eventRecords, aliasResolver);
  const authorRecords = buildAuthorRecords(eventRecords, aliasResolver);
  const driverRecordsByName = new Map(
    driverRecords.map((record) => [record.canonicalName, record]),
  );
  const authorRecordsByName = new Map(
    authorRecords.map((record) => [record.canonicalName, record]),
  );

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    rm(indexFilePath, { force: true }),
    rm(eventsDirectory, { recursive: true, force: true }),
    rm(driversDirectory, { recursive: true, force: true }),
    rm(authorsDirectory, { recursive: true, force: true }),
  ]);

  await Promise.all([
    mkdir(eventsDirectory, { recursive: true }),
    mkdir(driversDirectory, { recursive: true }),
    mkdir(authorsDirectory, { recursive: true }),
  ]);

  const driverFileNames = new Map(
    driverRecords.flatMap((record) =>
      record.aliases.map((alias) => [alias, record.htmlFileName] as const),
    ),
  );
  const authorFileNames = new Map(
    authorRecords.flatMap((record) =>
      record.aliases.map((alias) => [alias, record.htmlFileName] as const),
    ),
  );

  await Promise.all([
    writeIndexPage(eventRecords, driverFileNames, authorFileNames),
    writeDriverIndexPage(driverRecords, authorRecordsByName, authorFileNames),
    ...eventRecords.map((eventRecord) =>
      writeEventPage(eventRecord, driverFileNames, authorFileNames),
    ),
    ...driverRecords.map((driverRecord) =>
      writeDriverPage(
        driverRecord,
        eventRecords,
        authorRecordsByName,
        driverFileNames,
        authorFileNames,
      ),
    ),
    ...authorRecords.map((authorRecord) =>
      writeAuthorPage(
        authorRecord,
        eventRecords,
        driverRecordsByName,
        driverFileNames,
        authorFileNames,
      ),
    ),
  ]);

  console.log(
    `Generated HTML pages in ${path.relative(projectRoot, outputDirectory)} for ${eventRecords.length} events, ${driverRecords.length} drivers, and ${authorRecords.length} authors.`,
  );
}

async function loadEventRecords(): Promise<EventRecord[]> {
  const fileNames = (await readdir(resultsDirectory))
    .filter(
      (fileName) =>
        fileName.toLowerCase().endsWith(".json") &&
        /^\d+-.*\.json$/i.test(fileName),
    )
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  const records = await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(resultsDirectory, fileName);
      const fileContent = await readFile(filePath, "utf8");
      const parsed = JSON.parse(fileContent) as CupResultFile;
      const filteredResults = parsed.results.filter(
        (result) => !isCommentResultName(result.name),
      );
      const authors = splitAuthors(parsed.author);

      return {
        ...parsed,
        results: filteredResults,
        jsonFileName: fileName,
        htmlFileName: `${path.basename(fileName, ".json")}.html`,
        podium: buildPodium(filteredResults),
        authors,
      } satisfies EventRecord;
    }),
  );

  return records.sort((left, right) => left.nr - right.nr);
}

async function loadAliasResolver(): Promise<AliasResolver> {
  const [manualAliases, generatedAliases] = await Promise.all([
    loadAliasList(manualAliasListPath, false),
    loadAliasList(generatedAliasListPath, true),
  ]);

  const aliasGraph = new Map<string, Set<string>>();
  const manualCanonicalOrder = new Map<string, number>();
  const generatedCanonicalOrder = new Map<string, number>();

  registerAliasList(manualAliases, aliasGraph, manualCanonicalOrder);
  registerAliasList(generatedAliases, aliasGraph, generatedCanonicalOrder);

  const canonicalByName = new Map<string, string>();
  const aliasesByCanonical = new Map<string, string[]>();
  const visited = new Set<string>();

  for (const name of Array.from(aliasGraph.keys()).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (visited.has(name)) {
      continue;
    }

    const stack = [name];
    const component: string[] = [];
    visited.add(name);

    while (stack.length > 0) {
      const current = stack.pop();

      if (!current) {
        continue;
      }

      component.push(current);

      for (const neighbor of aliasGraph.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    const sortedComponent = component.sort((left, right) =>
      left.localeCompare(right),
    );
    const canonicalName = pickCanonicalName(
      sortedComponent,
      manualCanonicalOrder,
      generatedCanonicalOrder,
    );

    aliasesByCanonical.set(canonicalName, sortedComponent);

    for (const alias of sortedComponent) {
      canonicalByName.set(alias, canonicalName);
    }
  }

  return {
    canonicalByName,
    aliasesByCanonical,
  };
}

async function loadAliasList(
  filePath: string,
  optional: boolean,
): Promise<AliasList> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as AliasList;
  } catch (error: unknown) {
    if (
      optional &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }

    throw error;
  }
}

function registerAliasList(
  aliasList: AliasList,
  aliasGraph: Map<string, Set<string>>,
  canonicalOrder: Map<string, number>,
): void {
  for (const [index, [rawCanonicalName, rawAliases]] of Object.entries(
    aliasList,
  ).entries()) {
    const canonicalName = normalizeWhitespace(rawCanonicalName);
    canonicalOrder.set(canonicalName, index);

    const aliases = [canonicalName, ...rawAliases]
      .map(normalizeWhitespace)
      .filter((name) => name.length > 0);

    for (const alias of aliases) {
      if (!aliasGraph.has(alias)) {
        aliasGraph.set(alias, new Set());
      }

      if (!aliasGraph.has(canonicalName)) {
        aliasGraph.set(canonicalName, new Set());
      }

      aliasGraph.get(canonicalName)?.add(alias);
      aliasGraph.get(alias)?.add(canonicalName);
    }
  }
}

function pickCanonicalName(
  names: string[],
  manualCanonicalOrder: Map<string, number>,
  generatedCanonicalOrder: Map<string, number>,
): string {
  const manualCandidates = names
    .filter((name) => manualCanonicalOrder.has(name))
    .sort(
      (left, right) =>
        (manualCanonicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (manualCanonicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  if (manualCandidates.length > 0) {
    return manualCandidates[0];
  }

  const generatedCandidates = names
    .filter((name) => generatedCanonicalOrder.has(name))
    .sort(
      (left, right) =>
        (generatedCanonicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (generatedCanonicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  if (generatedCandidates.length > 0) {
    return generatedCandidates[0];
  }

  return names[0] ?? "Unknown";
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isCommentResultName(value: string): boolean {
  return value.trim().startsWith("*");
}

function resolveAlias(name: string, aliasResolver: AliasResolver): string {
  const normalizedName = normalizeWhitespace(name);
  return aliasResolver.canonicalByName.get(normalizedName) ?? normalizedName;
}

function buildDriverRecords(
  eventRecords: EventRecord[],
  aliasResolver: AliasResolver,
): DriverRecord[] {
  const driverRecords = new Map<string, DriverRecord>();

  for (const eventRecord of eventRecords) {
    for (const result of eventRecord.results) {
      const canonicalName = resolveAlias(result.name, aliasResolver);

      if (!driverRecords.has(canonicalName)) {
        driverRecords.set(canonicalName, {
          canonicalName,
          htmlFileName: `${slugify(canonicalName)}-${stableId(canonicalName)}.html`,
          aliases: aliasResolver.aliasesByCanonical.get(canonicalName) ?? [
            canonicalName,
          ],
          fastestTimes: 0,
          results: [],
        });
      }

      driverRecords.get(canonicalName)?.results.push({ eventRecord, result });
    }

    if (eventRecord.fastestTimeDriver) {
      const canonicalName = resolveAlias(
        eventRecord.fastestTimeDriver,
        aliasResolver,
      );

      if (!driverRecords.has(canonicalName)) {
        driverRecords.set(canonicalName, {
          canonicalName,
          htmlFileName: `${slugify(canonicalName)}-${stableId(canonicalName)}.html`,
          aliases: aliasResolver.aliasesByCanonical.get(canonicalName) ?? [
            canonicalName,
          ],
          fastestTimes: 0,
          results: [],
        });
      }

      const driverRecord = driverRecords.get(canonicalName);

      if (driverRecord) {
        driverRecord.fastestTimes += 1;
      }
    }
  }

  return Array.from(driverRecords.values())
    .map((driverRecord) => ({
      ...driverRecord,
      aliases: Array.from(
        new Set([driverRecord.canonicalName, ...driverRecord.aliases]),
      ).sort((left, right) => left.localeCompare(right)),
      results: [...driverRecord.results].sort(
        (left, right) => left.eventRecord.nr - right.eventRecord.nr,
      ),
    }))
    .sort((left, right) =>
      left.canonicalName.localeCompare(right.canonicalName),
    );
}

function buildAuthorRecords(
  eventRecords: EventRecord[],
  aliasResolver: AliasResolver,
): AuthorRecord[] {
  const authorRecords = new Map<string, AuthorRecord>();

  for (const eventRecord of eventRecords) {
    for (const author of eventRecord.authors) {
      const canonicalName = resolveAlias(author, aliasResolver);

      if (!authorRecords.has(canonicalName)) {
        authorRecords.set(canonicalName, {
          canonicalName,
          htmlFileName: `${slugify(canonicalName)}-${stableId(canonicalName)}.html`,
          aliases: aliasResolver.aliasesByCanonical.get(canonicalName) ?? [
            canonicalName,
          ],
          tracks: [],
        });
      }

      const authorRecord = authorRecords.get(canonicalName);

      if (
        authorRecord &&
        !authorRecord.tracks.some((track) => track.nr === eventRecord.nr)
      ) {
        authorRecord.tracks.push(eventRecord);
      }
    }
  }

  return Array.from(authorRecords.values())
    .map((authorRecord) => ({
      ...authorRecord,
      aliases: Array.from(
        new Set([authorRecord.canonicalName, ...authorRecord.aliases]),
      ).sort((left, right) => left.localeCompare(right)),
      tracks: [...authorRecord.tracks].sort(
        (left, right) => left.nr - right.nr,
      ),
    }))
    .sort((left, right) =>
      left.canonicalName.localeCompare(right.canonicalName),
    );
}

function splitAuthors(authorValue: string): string[] {
  return authorValue
    .split(/\s+(?:&|and)\s+/i)
    .map((value) => value.trim())
    .filter(
      (value, index, values) =>
        value.length > 0 && values.indexOf(value) === index,
    );
}

function buildPodium(
  results: ResultEntry[],
): Array<{ placing: number; entries: ResultEntry[] }> {
  return [1, 2, 3]
    .map((placing) => ({
      placing,
      entries: results.filter((result) => result.placing === placing),
    }))
    .filter((group) => group.entries.length > 0);
}

async function writeIndexPage(
  eventRecords: EventRecord[],
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const rows = eventRecords
    .map((eventRecord) => {
      const podium = renderPodium(eventRecord, driverFileNames, ".");
      const authors = renderAuthorLinks(
        eventRecord.authors,
        authorFileNames,
        ".",
      );
      const fastestDriver = eventRecord.fastestTimeDriver
        ? renderDriverLink(eventRecord.fastestTimeDriver, driverFileNames, ".")
        : "-";

      return `
        <tr>
          <td><a href="events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td><a href="events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${authors}</td>
          <td>${eventRecord.fastestTime ? escapeHtml(eventRecord.fastestTime) : "-"}</td>
          <td>${fastestDriver}</td>
          <td>${eventRecord.fastestTimeRound ? escapeHtml(eventRecord.fastestTimeRound) : "-"}</td>
          <td>${podium}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    "Cup of the Day Overview",
    `
      <h1>Cup of the Day Overview</h1>
      <p>${eventRecords.length} events indexed from generated JSON files.</p>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Map</th>
            <th>Author</th>
            <th>Fastest Time</th>
            <th>Fastest Driver</th>
            <th>Fastest Round</th>
            <th>Podium</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `,
    {
      pageTitle: "Cup of the Day Overview",
      rootPrefix: ".",
    },
  );

  await writeFile(indexFilePath, content, "utf8");
}

async function writeDriverIndexPage(
  driverRecords: DriverRecord[],
  authorRecordsByName: Map<string, AuthorRecord>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const rows = driverRecords
    .map((driverRecord) => {
      const stats = buildDriverStats(driverRecord);
      const aliasSummary = renderAliasSummary(
        driverRecord.aliases,
        driverRecord.canonicalName,
      );
      const authorPage = authorRecordsByName.has(driverRecord.canonicalName)
        ? renderAuthorLinks([driverRecord.canonicalName], authorFileNames, "..")
        : "-";
      const searchTerms = normalizeSearchText(
        [driverRecord.canonicalName, ...driverRecord.aliases].join(" "),
      );

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}">
          <td><a href="${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(driverRecord.canonicalName)}</a></td>
          <td>${aliasSummary}</td>
          <td>${stats.starts}</td>
          <td>${stats.wins}</td>
          <td>${stats.fastestTimes}</td>
          <td>${authorPage}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    "Drivers",
    `
      <h1>Drivers</h1>
      <p>${driverRecords.length} driver profiles. Search by canonical name or any alias.</p>
      <div class="search-panel">
        <label class="search-label" for="driver-search">Search drivers</label>
        <input
          id="driver-search"
          class="search-input"
          type="search"
          placeholder="Type a driver name or alias"
          autocomplete="off"
          data-driver-search-input
        >
        <p class="search-summary" data-driver-search-summary>${driverRecords.length} drivers shown</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Aliases</th>
            <th>Starts</th>
            <th>Wins</th>
            <th>Fastest Times</th>
            <th>Author Page</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `,
    {
      pageTitle: "Drivers",
      rootPrefix: "..",
    },
  );

  await writeFile(driverIndexFilePath, content, "utf8");
}

async function writeEventPage(
  eventRecord: EventRecord,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const resultRows = eventRecord.results
    .map(
      (result) => `
        <tr>
          <td>${result.placing ?? "-"}</td>
          <td>${renderDriverLink(result.name, driverFileNames, "..")}</td>
          <td>${escapeHtml(result.time)}</td>
          <td>${result.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
        </tr>`,
    )
    .join("\n");

  const content = renderLayout(
    `COTD ${eventRecord.nr} - ${eventRecord.map}`,
    `
      <h1>COTD ${eventRecord.nr}</h1>
      <h2>${escapeHtml(eventRecord.map)}</h2>
      <table>
        <tbody>
          <tr><th>Map</th><td>${escapeHtml(eventRecord.map)}</td></tr>
          <tr><th>Author</th><td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td></tr>
          <tr><th>Fastest Time</th><td>${eventRecord.fastestTime ? escapeHtml(eventRecord.fastestTime) : "-"}</td></tr>
          <tr><th>Fastest Driver</th><td>${eventRecord.fastestTimeDriver ? renderDriverLink(eventRecord.fastestTimeDriver, driverFileNames, "..") : "-"}</td></tr>
          <tr><th>Fastest Round</th><td>${eventRecord.fastestTimeRound ? escapeHtml(eventRecord.fastestTimeRound) : "-"}</td></tr>
          <tr><th>Source JSON</th><td>${escapeHtml(eventRecord.jsonFileName)}</td></tr>
          <tr><th>Source CSV</th><td>${escapeHtml(eventRecord.sourceFile)}</td></tr>
          <tr><th>Podium</th><td>${renderPodium(eventRecord, driverFileNames, "..")}</td></tr>
        </tbody>
      </table>
      <h2>Results</h2>
      <table>
        <thead>
          <tr>
            <th>Placing</th>
            <th>Driver</th>
            <th>Time</th>
            <th>Elimination Round</th>
          </tr>
        </thead>
        <tbody>
          ${resultRows}
        </tbody>
      </table>
    `,
    {
      pageTitle: `COTD ${eventRecord.nr} - ${eventRecord.map}`,
      rootPrefix: "..",
    },
  );

  await writeFile(
    path.join(eventsDirectory, eventRecord.htmlFileName),
    content,
    "utf8",
  );
}

async function writeDriverPage(
  driverRecord: DriverRecord,
  eventRecords: EventRecord[],
  authorRecordsByName: Map<string, AuthorRecord>,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const matchingAuthorRecord =
    authorRecordsByName.get(driverRecord.canonicalName) ?? null;

  const content = renderLayout(
    driverRecord.canonicalName,
    `
      ${renderProfileHeading(driverRecord.canonicalName, driverRecord.aliases)}
      ${renderProfileMetadata(
        driverRecord,
        matchingAuthorRecord,
        driverFileNames,
        authorFileNames,
        "..",
      )}
      ${renderProfileTabs(
        renderRaceResultsSection(driverRecord, eventRecords, authorFileNames),
        renderTracksSection(
          matchingAuthorRecord,
          driverFileNames,
          authorFileNames,
        ),
        "race-results",
      )}
    `,
    {
      pageTitle: driverRecord.canonicalName,
      rootPrefix: "..",
    },
  );

  await writeFile(
    path.join(driversDirectory, driverRecord.htmlFileName),
    content,
    "utf8",
  );
}

async function writeAuthorPage(
  authorRecord: AuthorRecord,
  eventRecords: EventRecord[],
  driverRecordsByName: Map<string, DriverRecord>,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const matchingDriverRecord =
    driverRecordsByName.get(authorRecord.canonicalName) ?? null;

  const content = renderLayout(
    authorRecord.canonicalName,
    `
      ${renderProfileHeading(authorRecord.canonicalName, authorRecord.aliases)}
      ${renderProfileMetadata(
        matchingDriverRecord,
        authorRecord,
        driverFileNames,
        authorFileNames,
        "..",
      )}
      ${renderProfileTabs(
        renderRaceResultsSection(
          matchingDriverRecord,
          eventRecords,
          authorFileNames,
        ),
        renderTracksSection(authorRecord, driverFileNames, authorFileNames),
        "tracks",
      )}
    `,
    {
      pageTitle: authorRecord.canonicalName,
      rootPrefix: "..",
    },
  );

  await writeFile(
    path.join(authorsDirectory, authorRecord.htmlFileName),
    content,
    "utf8",
  );
}

function getDriverResultRecords(
  driverRecord: DriverRecord,
): DriverResultRecord[] {
  return [...driverRecord.results].sort(
    (left, right) => left.eventRecord.nr - right.eventRecord.nr,
  );
}

function buildDriverStats(driverRecord: DriverRecord): DriverStats {
  const driverResults = getDriverResultRecords(driverRecord);
  const wins = driverResults.filter(
    (entry) => entry.result.placing === 1,
  ).length;
  const podiums = driverResults.filter(
    (entry) => entry.result.placing !== null && entry.result.placing <= 3,
  ).length;
  const bestFinish = driverResults.reduce<number | null>((best, entry) => {
    if (entry.result.placing === null) {
      return best;
    }

    if (best === null || entry.result.placing < best) {
      return entry.result.placing;
    }

    return best;
  }, null);

  return {
    starts: driverResults.length,
    wins,
    podiums,
    bestFinish,
    fastestTimes: driverRecord.fastestTimes,
  };
}

function buildAuthorStats(authorRecord: AuthorRecord): AuthorStats {
  const sortedTracks = [...authorRecord.tracks].sort(
    (left, right) => left.nr - right.nr,
  );
  const soloTracks = sortedTracks.filter(
    (eventRecord) => eventRecord.authors.length === 1,
  ).length;

  return {
    tracks: sortedTracks.length,
    soloTracks,
    coAuthoredTracks: sortedTracks.length - soloTracks,
    firstEvent: sortedTracks[0]?.nr ?? null,
    latestEvent: sortedTracks.at(-1)?.nr ?? null,
  };
}

function renderProfileMetadata(
  driverRecord: DriverRecord | null,
  authorRecord: AuthorRecord | null,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  return `
    <div class="meta-grid">
      ${renderDriverMetadataTable(driverRecord, authorFileNames, rootPrefix)}
      ${renderAuthorMetadataTable(authorRecord, driverFileNames, rootPrefix)}
    </div>
  `;
}

function renderProfileHeading(
  canonicalName: string,
  aliases: string[],
): string {
  const aliasSummary = renderAliasSummary(aliases, canonicalName);

  return `
    <h1 class="name">${escapeHtml(canonicalName)}</h1>
    ${aliasSummary === "-" ? "" : `<div class="aliases"><span>AKA:</span> <em>${aliasSummary}</em></div>`}
  `;
}

function renderDriverMetadataTable(
  driverRecord: DriverRecord | null,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (driverRecord === null) {
    return `
      <section>
        <h3>Driver</h3>
        <p>No race results found for this name.</p>
      </section>
    `;
  }

  const stats = buildDriverStats(driverRecord);
  const authorPage = authorFileNames.has(driverRecord.canonicalName)
    ? renderAuthorLinks(
        [driverRecord.canonicalName],
        authorFileNames,
        rootPrefix,
      )
    : "-";

  return `
    <section>
      <h3>Driver</h3>
      <table>
        <tbody>
          <tr><th>Starts</th><td>${stats.starts}</td></tr>
          <tr><th>Wins</th><td>${stats.wins}</td></tr>
          <tr><th>Podiums</th><td>${stats.podiums}</td></tr>
          <tr><th>Best Finish</th><td>${stats.bestFinish ?? "-"}</td></tr>
          <tr><th>Fastest Times</th><td>${stats.fastestTimes}</td></tr>
          <tr><th>Author Page</th><td>${authorPage}</td></tr>
        </tbody>
      </table>
    </section>
  `;
}

function renderAuthorMetadataTable(
  authorRecord: AuthorRecord | null,
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (authorRecord === null) {
    return `
      <section>
        <h3>Author</h3>
        <p>No authored tracks found for this name.</p>
      </section>
    `;
  }

  const stats = buildAuthorStats(authorRecord);
  const driverPage = driverFileNames.has(authorRecord.canonicalName)
    ? renderDriverLink(authorRecord.canonicalName, driverFileNames, rootPrefix)
    : "-";

  return `
    <section>
      <h3>Author</h3>
      <table>
        <tbody>
          <tr><th>Tracks</th><td>${stats.tracks}</td></tr>
          <tr><th>Solo Tracks</th><td>${stats.soloTracks}</td></tr>
          <tr><th>Co-Authored Tracks</th><td>${stats.coAuthoredTracks}</td></tr>
          <tr><th>First Event</th><td>${stats.firstEvent ?? "-"}</td></tr>
          <tr><th>Latest Event</th><td>${stats.latestEvent ?? "-"}</td></tr>
          <tr><th>Driver Page</th><td>${driverPage}</td></tr>
        </tbody>
      </table>
    </section>
  `;
}

function renderProfileTabs(
  raceResultsContent: string,
  tracksContent: string,
  defaultTab: "race-results" | "tracks",
): string {
  return `
    <div class="tab-list" role="tablist" aria-label="Profile sections" data-tabs data-default-tab="${defaultTab}">
      <button type="button" class="tab-button" role="tab" data-tab-target="race-results">Race Results</button>
      <button type="button" class="tab-button" role="tab" data-tab-target="tracks">Tracks</button>
    </div>
    <section id="race-results" class="tab-panel" role="tabpanel">
      ${raceResultsContent}
    </section>
    <section id="tracks" class="tab-panel" role="tabpanel" hidden>
      ${tracksContent}
    </section>
  `;
}

function renderRaceResultsSection(
  driverRecord: DriverRecord | null,
  eventRecords: EventRecord[],
  authorFileNames: Map<string, string>,
): string {
  if (driverRecord === null) {
    return `
      <h2>Race Results</h2>
      <p>No race results found for this name.</p>
    `;
  }

  const rows = buildDriverTimeline(driverRecord, eventRecords)
    .map(
      ({ eventRecord, result }) => `
        <tr${result === null ? ' class="did-not-race"' : ""}>
          <td><a href="../events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td><a href="../events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${result === null ? "Did not race" : "Raced"}</td>
          <td>${result?.placing ?? "-"}</td>
          <td>${result === null ? "-" : escapeHtml(result.time)}</td>
          <td>${result?.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
        </tr>`,
    )
    .join("\n");

  return `
    <h2>Race Results</h2>
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Map</th>
          <th>Author</th>
          <th>Status</th>
          <th>Placing</th>
          <th>Time</th>
          <th>Elimination Round</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function buildDriverTimeline(
  driverRecord: DriverRecord,
  eventRecords: EventRecord[],
): DriverTimelineRecord[] {
  const resultsByEvent = new Map(
    driverRecord.results.map((entry) => [entry.eventRecord.nr, entry.result]),
  );

  return eventRecords.map((eventRecord) => ({
    eventRecord,
    result: resultsByEvent.get(eventRecord.nr) ?? null,
  }));
}

function renderAliasSummary(aliases: string[], canonicalName: string): string {
  const otherAliases = aliases.filter((alias) => alias !== canonicalName);

  if (otherAliases.length === 0) {
    return "-";
  }

  return otherAliases.map((alias) => escapeHtml(alias)).join(", ");
}

function renderTracksSection(
  authorRecord: AuthorRecord | null,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): string {
  if (authorRecord === null) {
    return `
      <h2>Tracks</h2>
      <p>No authored tracks found for this name.</p>
    `;
  }

  const rows = [...authorRecord.tracks]
    .sort((left, right) => left.nr - right.nr)
    .map((eventRecord) => {
      const winners = eventRecord.results.filter(
        (result) => result.placing === 1,
      );

      return `
        <tr>
          <td><a href="../events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td><a href="../events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${renderDriverList(winners, driverFileNames, "..")}</td>
          <td>${eventRecord.fastestTime ? escapeHtml(eventRecord.fastestTime) : "-"}</td>
          <td>${eventRecord.fastestTimeDriver ? renderDriverLink(eventRecord.fastestTimeDriver, driverFileNames, "..") : "-"}</td>
        </tr>`;
    })
    .join("\n");

  return `
    <h2>Tracks</h2>
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Map</th>
          <th>All Authors</th>
          <th>Winner</th>
          <th>Fastest Time</th>
          <th>Fastest Driver</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderPodium(
  eventRecord: EventRecord,
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (eventRecord.podium.length === 0) {
    return "-";
  }

  return eventRecord.podium
    .map(
      (group) =>
        `${group.placing}: ${renderDriverList(group.entries, driverFileNames, rootPrefix)}`,
    )
    .join("<br>");
}

function renderDriverList(
  entries: ResultEntry[],
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (entries.length === 0) {
    return "-";
  }

  return entries
    .map((entry) => renderDriverLink(entry.name, driverFileNames, rootPrefix))
    .join(", ");
}

function renderDriverLink(
  name: string,
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  const fileName = driverFileNames.get(name);

  if (!fileName) {
    return escapeHtml(name);
  }

  return `<a href="${rootPrefix}/drivers/${fileName}">${escapeHtml(name)}</a>`;
}

function renderAuthorLinks(
  authors: string[],
  authorFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  return authors
    .map((author) => {
      const fileName = authorFileNames.get(author);

      if (!fileName) {
        return escapeHtml(author);
      }

      return `<a href="${rootPrefix}/authors/${fileName}">${escapeHtml(author)}</a>`;
    })
    .join(", ");
}

function renderLayout(
  title: string,
  bodyContent: string,
  options: { pageTitle: string; rootPrefix: string },
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.pageTitle)}</title>
    <link rel="stylesheet" href="${options.rootPrefix}/styles.css">
    <script>
      document.addEventListener("DOMContentLoaded", () => {
        for (const tabList of document.querySelectorAll("[data-tabs]")) {
          const buttons = Array.from(
            tabList.querySelectorAll("[data-tab-target]"),
          );

          const activate = (targetId) => {
            for (const button of buttons) {
              const isActive = button.dataset.tabTarget === targetId;
              button.classList.toggle("is-active", isActive);
              button.setAttribute("aria-selected", String(isActive));
            }

            for (const button of buttons) {
              const target = button.dataset.tabTarget;
              if (!target) {
                continue;
              }

              const panel = document.getElementById(target);
              if (panel) {
                panel.hidden = panel.id !== targetId;
              }
            }
          };

          const requestedHash = window.location.hash.replace("#", "");
          const defaultTab = tabList.dataset.defaultTab || buttons[0]?.dataset.tabTarget;
          const initialTab = buttons.some(
            (button) => button.dataset.tabTarget === requestedHash,
          )
            ? requestedHash
            : defaultTab;

          if (initialTab) {
            activate(initialTab);
          }

          for (const button of buttons) {
            button.addEventListener("click", () => {
              const targetId = button.dataset.tabTarget;
              if (!targetId) {
                return;
              }

              activate(targetId);

              if (window.history?.replaceState) {
                window.history.replaceState(null, "", "#" + targetId);
              } else {
                window.location.hash = targetId;
              }
            });
          }
        }

        const driverSearchInput = document.querySelector("[data-driver-search-input]");
        const driverSearchSummary = document.querySelector("[data-driver-search-summary]");
        const driverRows = Array.from(document.querySelectorAll("[data-driver-row]"));

        if (driverSearchInput && driverSearchSummary && driverRows.length > 0) {
          const updateDriverFilter = () => {
            const query = (driverSearchInput.value || "").trim().toLowerCase();
            let visibleCount = 0;

            for (const row of driverRows) {
              const haystack = (row.getAttribute("data-driver-search") || "").toLowerCase();
              const isVisible = query.length === 0 || haystack.includes(query);
              row.hidden = !isVisible;

              if (isVisible) {
                visibleCount += 1;
              }
            }

            driverSearchSummary.textContent = visibleCount + " driver" + (visibleCount === 1 ? "" : "s") + " shown";
          };

          driverSearchInput.addEventListener("input", updateDriverFilter);
          updateDriverFilter();
        }
      });
    </script>
  </head>
  <body>
    <nav>
      <a href="${options.rootPrefix}/index.html">Overview</a>
      <a href="${options.rootPrefix}/drivers/index.html">Drivers</a>
    </nav>
    ${bodyContent}
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "unknown";
}

function stableId(value: string): string {
  let hash = 2166136261;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate HTML pages: ${message}`);
  process.exitCode = 1;
});
