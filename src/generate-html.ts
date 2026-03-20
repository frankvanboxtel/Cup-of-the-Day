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

type RaceResultsGraphPoint = {
  eventNumber: number;
  placing: number | null;
  title: string;
  href: string | null;
};

type RaceResultsGraphSeries = {
  id: string;
  label: string;
  color: string;
  href: string | null;
  points: RaceResultsGraphPoint[];
};

type DriverStats = {
  starts: number;
  wins: number;
  winRate: number;
  podiums: number;
  podiumRate: number;
  bestFinish: number | null;
  fastestTimes: number;
  currentElo: number;
  peakElo: number;
};

type AuthorStats = {
  tracks: number;
  soloTracks: number;
  coAuthoredTracks: number;
  firstEvent: number | null;
  latestEvent: number | null;
};

type SortDirection = "asc" | "desc";
type SortType = "text" | "number";

type DriverRatingSummary = {
  currentElo: number;
  peakElo: number;
};

type DriverEventRating = {
  elo: number;
};

type CanonicalEventResult = {
  canonicalName: string;
  placing: number | null;
  time: string;
  eliminationRound: string | null;
};

type EventRatings = {
  elo: Map<string, number>;
  summary: Map<string, DriverRatingSummary>;
  history: Map<string, Map<number, DriverEventRating>>;
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "results");
const outputDirectory = path.join(projectRoot, "html");
const eventsDirectory = path.join(outputDirectory, "events");
const driversDirectory = path.join(outputDirectory, "drivers");
const placingsDirectory = path.join(outputDirectory, "placings");
const raceResultsGraphDirectory = path.join(
  outputDirectory,
  "race-results-graph",
);
const authorsDirectory = path.join(outputDirectory, "authors");
const indexFilePath = path.join(outputDirectory, "index.html");
const driverIndexFilePath = path.join(driversDirectory, "index.html");
const placingsIndexFilePath = path.join(placingsDirectory, "index.html");
const raceResultsGraphIndexFilePath = path.join(
  raceResultsGraphDirectory,
  "index.html",
);
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
const initialElo = 1500;
const eloKFactor = 32;
const graphMaxPlacing = 20;
const graphOverflowBucket = graphMaxPlacing + 1;
const combinedGraphDefaultSelectionCount = 3;
const combinedGraphQuickPickCount = 10;
const graphPalette = [
  "#0047ab",
  "#d1495b",
  "#2a9d8f",
  "#f4a261",
  "#6c5ce7",
  "#e76f51",
  "#264653",
  "#8ab17d",
  "#c1121f",
  "#577590",
];

async function main(): Promise<void> {
  const aliasResolver = await loadAliasResolver();
  const eventRecords = await loadEventRecords();
  const eventRatings = buildEventRatings(eventRecords, aliasResolver);
  const driverRatingHistory = eventRatings.history;
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
    rm(placingsDirectory, { recursive: true, force: true }),
    rm(raceResultsGraphDirectory, { recursive: true, force: true }),
    rm(authorsDirectory, { recursive: true, force: true }),
  ]);

  await Promise.all([
    mkdir(eventsDirectory, { recursive: true }),
    mkdir(driversDirectory, { recursive: true }),
    mkdir(placingsDirectory, { recursive: true }),
    mkdir(raceResultsGraphDirectory, { recursive: true }),
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
    writeDriverIndexPage(
      driverRecords,
      authorRecordsByName,
      authorFileNames,
      eventRatings.summary,
    ),
    writePlacingsIndexPage(driverRecords, eventRatings.summary),
    writeRaceResultsGraphIndexPage(driverRecords, eventRecords),
    ...eventRecords.map((eventRecord, index) =>
      writeEventPage(
        eventRecord,
        driverFileNames,
        authorFileNames,
        eventRecords[index - 1] ?? null,
        eventRecords[index + 1] ?? null,
      ),
    ),
    ...driverRecords.map((driverRecord) =>
      writeDriverPage(
        driverRecord,
        eventRecords,
        authorRecordsByName,
        driverFileNames,
        authorFileNames,
        eventRatings.summary,
        driverRatingHistory,
      ),
    ),
    ...authorRecords.map((authorRecord) =>
      writeAuthorPage(
        authorRecord,
        eventRecords,
        driverRecordsByName,
        driverFileNames,
        authorFileNames,
        eventRatings.summary,
        driverRatingHistory,
      ),
    ),
  ]);

  console.log(
    `Generated HTML pages in ${path.relative(projectRoot, outputDirectory)} for ${eventRecords.length} events, ${driverRecords.length} players, and ${authorRecords.length} authors.`,
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
  const normalized = value.trim().toLowerCase();

  if (normalized.startsWith("*")) {
    return true;
  }

  const blockedPhrases = [
    "at the time of leaving",
    "at time of leaving",
    "had to leave",
    "awarded joint",
    "due to disconnection",
    "would not have",
    "despite not being knocked out",
    "prevented",
  ];

  return blockedPhrases.some((phrase) => normalized.includes(phrase));
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

function buildEventRatings(
  eventRecords: EventRecord[],
  aliasResolver: AliasResolver,
): EventRatings {
  const elo = new Map<string, number>();
  const summary = new Map<string, DriverRatingSummary>();
  const history = new Map<string, Map<number, DriverEventRating>>();

  for (const eventRecord of eventRecords) {
    const participants = buildCanonicalEventResults(eventRecord, aliasResolver);

    if (participants.length === 0) {
      continue;
    }

    for (const participant of participants) {
      ensureRatingParticipant(participant.canonicalName, elo, summary);
    }

    applyEloEventResults(participants, elo, summary);

    for (const participant of participants) {
      const participantSummary = summary.get(participant.canonicalName);

      if (!participantSummary) {
        continue;
      }

      if (!history.has(participant.canonicalName)) {
        history.set(participant.canonicalName, new Map());
      }

      history.get(participant.canonicalName)?.set(eventRecord.nr, {
        elo: participantSummary.currentElo,
      });
    }
  }

  return {
    elo,
    summary,
    history,
  };
}

function buildCanonicalEventResults(
  eventRecord: EventRecord,
  aliasResolver: AliasResolver,
): CanonicalEventResult[] {
  const byDriver = new Map<string, CanonicalEventResult>();

  for (const result of eventRecord.results) {
    const canonicalName = resolveAlias(result.name, aliasResolver);
    const existing = byDriver.get(canonicalName);

    if (!existing) {
      byDriver.set(canonicalName, {
        canonicalName,
        placing: result.placing,
        time: result.time,
        eliminationRound: result.eliminationRound,
      });
      continue;
    }

    const currentPlacing = result.placing ?? Number.MAX_SAFE_INTEGER;
    const existingPlacing = existing.placing ?? Number.MAX_SAFE_INTEGER;

    if (currentPlacing < existingPlacing) {
      byDriver.set(canonicalName, {
        canonicalName,
        placing: result.placing,
        time: result.time,
        eliminationRound: result.eliminationRound,
      });
    }
  }

  return Array.from(byDriver.values()).sort((left, right) => {
    const leftPlacing = left.placing ?? Number.MAX_SAFE_INTEGER;
    const rightPlacing = right.placing ?? Number.MAX_SAFE_INTEGER;

    if (leftPlacing !== rightPlacing) {
      return leftPlacing - rightPlacing;
    }

    return left.canonicalName.localeCompare(right.canonicalName);
  });
}

function ensureRatingParticipant(
  canonicalName: string,
  elo: Map<string, number>,
  summary: Map<string, DriverRatingSummary>,
): void {
  if (!elo.has(canonicalName)) {
    elo.set(canonicalName, initialElo);
  }

  if (!summary.has(canonicalName)) {
    summary.set(canonicalName, {
      currentElo: initialElo,
      peakElo: initialElo,
    });
  }
}

function applyEloEventResults(
  participants: CanonicalEventResult[],
  eloRatings: Map<string, number>,
  summary: Map<string, DriverRatingSummary>,
): void {
  if (participants.length === 0) {
    return;
  }

  const adjustments = new Map<string, number>();
  const pairScale = Math.max(1, participants.length - 1);

  for (const participant of participants) {
    adjustments.set(participant.canonicalName, 0);
  }

  for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < participants.length;
      rightIndex += 1
    ) {
      const left = participants[leftIndex];
      const right = participants[rightIndex];
      const leftRating = eloRatings.get(left.canonicalName) ?? initialElo;
      const rightRating = eloRatings.get(right.canonicalName) ?? initialElo;
      const expectedLeft = 1 / (1 + 10 ** ((rightRating - leftRating) / 400));
      const actualLeft = comparePlacings(left.placing, right.placing);
      const change = (eloKFactor / pairScale) * (actualLeft - expectedLeft);

      adjustments.set(
        left.canonicalName,
        (adjustments.get(left.canonicalName) ?? 0) + change,
      );
      adjustments.set(
        right.canonicalName,
        (adjustments.get(right.canonicalName) ?? 0) - change,
      );
    }
  }

  for (const participant of participants) {
    const current = eloRatings.get(participant.canonicalName) ?? initialElo;
    const next = current + (adjustments.get(participant.canonicalName) ?? 0);
    const participantSummary = summary.get(participant.canonicalName);

    eloRatings.set(participant.canonicalName, next);

    if (participantSummary) {
      participantSummary.currentElo = next;
      participantSummary.peakElo = Math.max(participantSummary.peakElo, next);
    }
  }
}

function comparePlacings(
  leftPlacing: number | null,
  rightPlacing: number | null,
): number {
  if (leftPlacing === rightPlacing) {
    return 0.5;
  }

  if (leftPlacing === null) {
    return 0;
  }

  if (rightPlacing === null) {
    return 1;
  }

  return leftPlacing < rightPlacing ? 1 : 0;
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

function renderSortableHeader(
  label: string,
  key: string,
  type: SortType,
  defaultDirection: SortDirection,
  isActive = false,
  headerClass = "",
): string {
  const indicator = isActive ? (defaultDirection === "asc" ? "▲" : "▼") : "↕";
  const classAttribute =
    headerClass.length > 0 ? ` class="${escapeHtml(headerClass)}"` : "";

  return `<th${classAttribute}><a href="#" class="sorter${isActive ? " active" : ""}" data-sort-key="${escapeHtml(key)}" data-sort-type="${type}" data-sort-default-direction="${defaultDirection}" data-sort-direction="${isActive ? defaultDirection : ""}">${escapeHtml(label)} <span class="sort-indicator" aria-hidden="true">${indicator}</span></a></th>`;
}

function renderSortDataAttributes(
  values: Record<string, string | number | null | undefined>,
): string {
  return Object.entries(values)
    .map(
      ([key, value]) =>
        ` data-sort-${key}="${escapeHtml(value === null || value === undefined ? "" : String(value))}"`,
    )
    .join("");
}

function normalizeTextSortValue(value: string | null | undefined): string {
  return normalizeSearchText(value ?? "");
}

function normalizeNumberSortValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "";
  }

  return String(value);
}

function normalizeTimeSortValue(value: string | null | undefined): string {
  const milliseconds = parseRaceTimeToMilliseconds(value);
  return milliseconds === null ? "" : String(milliseconds);
}

function parseRaceTimeToMilliseconds(
  value: string | null | undefined,
): number | null {
  const normalized = value?.trim() ?? "";

  if (!normalized || normalized === "-" || /^dnf$/i.test(normalized)) {
    return null;
  }

  if (/^\d+(?:[.,]\d+)?$/.test(normalized)) {
    return Math.round(Number(normalized.replace(",", ".")) * 1000);
  }

  if (!normalized.includes(":")) {
    return null;
  }

  const parts = normalized.split(":").map((part) => part.trim());

  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part.length === 0 || Number.isNaN(Number(part.replace(",", "."))),
    )
  ) {
    return null;
  }

  let totalSeconds = 0;

  for (const part of parts) {
    totalSeconds = totalSeconds * 60 + Number(part.replace(",", "."));
  }

  return Math.round(totalSeconds * 1000);
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
      const fastestDriver = renderFastestPlayer(
        eventRecord,
        driverFileNames,
        ".",
      );
      const sortAttributes = renderSortDataAttributes({
        event: eventRecord.nr,
        map: normalizeTextSortValue(eventRecord.map),
        author: normalizeTextSortValue(eventRecord.authors.join(", ")),
        "fastest-time": normalizeTimeSortValue(eventRecord.fastestTime),
        "fastest-driver": normalizeTextSortValue(eventRecord.fastestTimeDriver),
      });

      return `
        <tr${sortAttributes}>
          <td class="number-cell"><a href="events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td class="bold"><a href="events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${authors}</td>
          <td class="align-right number-cell">${eventRecord.fastestTime ? formatRaceTimeHtml(eventRecord.fastestTime) : "-"}</td>
          <td>${fastestDriver}</td>
          <td>${podium}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    "Cup of the Day",
    `
      <h1>Cup of the Day</h1>
      <p>${eventRecords.length} events</p>
      <table data-sort-table>
        <thead>
          <tr>
            ${renderSortableHeader("Event", "event", "number", "asc", true, "number-cell")}
            ${renderSortableHeader("Track", "map", "text", "asc")}
            ${renderSortableHeader("Author", "author", "text", "asc")}
            ${renderSortableHeader("Fastest Time", "fastest-time", "number", "asc", false, "number-cell")}
            ${renderSortableHeader("Fastest Player", "fastest-driver", "text", "asc")}
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
  driverRatingSummary: Map<string, DriverRatingSummary>,
): Promise<void> {
  const rows = driverRecords
    .map((driverRecord) => {
      const stats = buildDriverStats(driverRecord, driverRatingSummary);
      const tracksCreated =
        authorRecordsByName.get(driverRecord.canonicalName)?.tracks.length ?? 0;
      const aliasSummary = renderAliasSummary(
        driverRecord.aliases,
        driverRecord.canonicalName,
      );
      const searchTerms = normalizeSearchText(
        [driverRecord.canonicalName, ...driverRecord.aliases].join(" "),
      );
      const sortAttributes = renderSortDataAttributes({
        driver: normalizeTextSortValue(driverRecord.canonicalName),
        tracks: normalizeNumberSortValue(tracksCreated),
        starts: normalizeNumberSortValue(stats.starts),
        wins: normalizeNumberSortValue(stats.wins),
        "win-rate": normalizeNumberSortValue(stats.winRate),
        podiums: normalizeNumberSortValue(stats.podiums),
        "podium-rate": normalizeNumberSortValue(stats.podiumRate),
        "fastest-times": normalizeNumberSortValue(stats.fastestTimes),
        elo: normalizeNumberSortValue(stats.currentElo),
      });

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}"${sortAttributes}>
          <td><a href="${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(driverRecord.canonicalName)}</a></td>
          <td title="${driverRecord.aliases.join(", ")}"><div class="single-line alias">${aliasSummary}</div></td>
          ${renderZeroValueCountCell(tracksCreated)}
          ${renderZeroValueCountCell(stats.starts)}
          ${renderZeroValueCountCell(stats.wins)}
          ${renderZeroValuePercentageCell(stats.winRate)}
          ${renderZeroValueCountCell(stats.podiums)}
          ${renderZeroValuePercentageCell(stats.podiumRate)}
          ${renderZeroValueCountCell(stats.fastestTimes)}
          <td class="align-right">${formatElo(stats.currentElo)}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    "Players",
    `
      <h1>Players</h1>
      <p>${driverRecords.length} player profiles. Search by canonical name or any alias.</p>
      <div class="search-panel">
        <label class="search-label" for="driver-search">Search players</label>
        <input
          id="driver-search"
          class="search-input"
          type="search"
          placeholder="Type a player name or alias"
          autocomplete="off"
          data-driver-search-input
        >
        <p class="search-summary" data-driver-search-summary>${driverRecords.length} players shown</p>
      </div>
      <table data-sort-table>
        <thead>
          <tr>
            ${renderSortableHeader("Player", "driver", "text", "asc")}
            <th>Aliases</th>
            ${renderSortableHeader("Tracks", "tracks", "number", "desc")}
            ${renderSortableHeader("Starts", "starts", "number", "desc")}
            ${renderSortableHeader("Wins", "wins", "number", "desc", true, "align-right")}
            ${renderSortableHeader("Win %", "win-rate", "number", "desc")}
            ${renderSortableHeader("Podiums", "podiums", "number", "desc")}
            ${renderSortableHeader("Podium %", "podium-rate", "number", "desc")}
            ${renderSortableHeader("Fastest Times", "fastest-times", "number", "desc")}
            ${renderSortableHeader("Elo", "elo", "number", "desc")}
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `,
    {
      pageTitle: "Players",
      rootPrefix: "..",
    },
  );

  await writeFile(driverIndexFilePath, content, "utf8");
}

async function writePlacingsIndexPage(
  driverRecords: DriverRecord[],
  driverRatingSummary: Map<string, DriverRatingSummary>,
): Promise<void> {
  const placingColumns = Array.from({ length: 25 }, (_, index) => index + 1);
  const rows = driverRecords
    .map((driverRecord) => {
      const stats = buildDriverStats(driverRecord, driverRatingSummary);
      const searchTerms = normalizeSearchText(
        [driverRecord.canonicalName, ...driverRecord.aliases].join(" "),
      );
      const placingCounts = buildPlacingCounts(driverRecord);
      const finals = (placingCounts[0] ?? 0) + (placingCounts[1] ?? 0);
      const podiums = finals + (placingCounts[2] ?? 0);
      const top6 =
        podiums +
        (placingCounts[3] ?? 0) +
        (placingCounts[4] ?? 0) +
        (placingCounts[5] ?? 0);
      const top10 =
        top6 +
        (placingCounts[6] ?? 0) +
        (placingCounts[7] ?? 0) +
        (placingCounts[8] ?? 0) +
        (placingCounts[9] ?? 0);
      const top25 = placingCounts
        .slice(0, 25)
        .reduce((sum, count) => sum + count, 0);
      const sortAttributes = renderSortDataAttributes({
        driver: normalizeTextSortValue(driverRecord.canonicalName),
        starts: normalizeNumberSortValue(stats.starts),
        wins: normalizeNumberSortValue(stats.wins),
        finals: normalizeNumberSortValue(finals),
        podiums: normalizeNumberSortValue(podiums),
        "top-6": normalizeNumberSortValue(top6),
        "top-10": normalizeNumberSortValue(top10),
        "top-25": normalizeNumberSortValue(top25),
        ...Object.fromEntries(
          placingColumns.map((placing) => [
            `placing-${placing}`,
            normalizeNumberSortValue(placingCounts[placing - 1] ?? 0),
          ]),
        ),
      });
      const placingCells = placingColumns
        .map((placing) =>
          renderPlacingCountCell(placingCounts[placing - 1] ?? 0, placing),
        )
        .join("");

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}"${sortAttributes}>
          <td><a href="../drivers/${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(driverRecord.canonicalName)}</a></td>
          ${renderZeroValueCountCell(stats.starts)}
          ${renderZeroValueCountCell(stats.wins)}
          ${renderZeroValueCountCell(finals)}
          ${renderZeroValueCountCell(podiums)}
          ${renderZeroValueCountCell(top6)}
          ${renderZeroValueCountCell(top10)}
          ${renderZeroValueCountCell(top25)}
          ${placingCells}
        </tr>`;
    })
    .join("\n");
  const placingHeaders = placingColumns
    .map((placing) =>
      renderSortableHeader(
        formatPlacingLabel(placing),
        `placing-${placing}`,
        "number",
        "desc",
        false,
        "align-right",
      ),
    )
    .join("\n");

  const content = renderLayout(
    "Placings",
    `
      <h1>Placings</h1>
      <div class="search-panel">
        <label class="search-label" for="driver-search">Search players</label>
        <input
          id="driver-search"
          class="search-input"
          type="search"
          placeholder="Type a player name or alias"
          autocomplete="off"
          data-driver-search-input
        >
        <p class="search-summary" data-driver-search-summary>${driverRecords.length} players shown</p>
      </div>
      <table data-sort-table>
        <thead>
          <tr>
            ${renderSortableHeader("Player", "driver", "text", "asc")}
            ${renderSortableHeader("Starts", "starts", "number", "desc")}
            ${renderSortableHeader("Wins", "wins", "number", "desc", true, "align-right")}
            ${renderSortableHeader("Finals", "finals", "number", "desc")}
            ${renderSortableHeader("Podiums", "podiums", "number", "desc")}
            ${renderSortableHeader("Top 6s", "top-6", "number", "desc")}
            ${renderSortableHeader("Top 10s", "top-10", "number", "desc")}
            ${renderSortableHeader("Top 25s", "top-25", "number", "desc")}
            ${placingHeaders}
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `,
    {
      pageTitle: "Placings",
      rootPrefix: "..",
    },
  );

  await writeFile(placingsIndexFilePath, content, "utf8");
}

async function writeRaceResultsGraphIndexPage(
  driverRecords: DriverRecord[],
  eventRecords: EventRecord[],
): Promise<void> {
  const sortedDriverRecords = [...driverRecords].sort(
    (left, right) =>
      getDriverWinCount(right) - getDriverWinCount(left) ||
      getDriverResultRecords(right).length -
        getDriverResultRecords(left).length ||
      left.canonicalName.localeCompare(right.canonicalName),
  );
  const series = sortedDriverRecords.map((driverRecord, index) =>
    buildRaceResultsGraphSeries(
      driverRecord,
      eventRecords,
      graphPalette[index % graphPalette.length] ?? "#0047ab",
      `../drivers/${driverRecord.htmlFileName}`,
    ),
  );
  const defaultVisibleIds = series
    .slice(0, combinedGraphDefaultSelectionCount)
    .map((entry) => entry.id);
  const initialVisibleColors = new Map(
    defaultVisibleIds.map((seriesId, index) => [
      seriesId,
      graphPalette[index % graphPalette.length] ?? "#0047ab",
    ]),
  );
  const initialSeries = series.map((entry) => ({
    ...entry,
    color: initialVisibleColors.get(entry.id) ?? entry.color,
  }));

  const content = renderLayout(
    "Results Graph",
    `
      <h1>Results Graph</h1>
      <p>Combined placing graph for all players. The top ${combinedGraphDefaultSelectionCount} players are enabled by default. Only top ${graphMaxPlacing} placings are shown directly; anything below that is grouped into ${graphMaxPlacing}+. Breaks indicate no participation.</p>
      ${renderRaceResultsGraphSelector(series, defaultVisibleIds)}
      ${renderRaceResultsGraphSvg(initialSeries, eventRecords, false, true, defaultVisibleIds, "combined-race-results")}
    `,
    {
      pageTitle: "Results Graph",
      rootPrefix: "..",
    },
  );

  await writeFile(raceResultsGraphIndexFilePath, content, "utf8");
}

async function writeEventPage(
  eventRecord: EventRecord,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
  previousEventRecord: EventRecord | null,
  nextEventRecord: EventRecord | null,
): Promise<void> {
  const resultRows = eventRecord.results
    .map((result) => {
      const sortAttributes = renderSortDataAttributes({
        placing: normalizeNumberSortValue(result.placing),
        driver: normalizeTextSortValue(result.name),
        time: normalizeTimeSortValue(result.time),
        "elimination-round": normalizeTextSortValue(result.eliminationRound),
      });

      return `
        <tr${sortAttributes}>
          <td class="align-right number-cell">${result.placing ?? "-"}</td>
          <td>${renderDriverLink(result.name, driverFileNames, "..")}</td>
          <td class="align-right number-cell">${formatRaceTimeHtml(result.time)}</td>
          <td class="align-right number-cell">${result.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    `COTD ${eventRecord.nr} - ${eventRecord.map}`,
    `
      <div class="event-heading">
        <div class="event-heading-nav" aria-label="Event navigation">
          ${previousEventRecord ? `<a class="event-nav-link" href="${escapeHtml(previousEventRecord.htmlFileName)}" aria-label="Previous event: COTD ${previousEventRecord.nr}">&larr;</a>` : ""}
        </div>
        <h1>COTD ${eventRecord.nr}</h1>
        <div class="event-heading-nav" aria-label="Event navigation">
          ${nextEventRecord ? `<a class="event-nav-link" href="${escapeHtml(nextEventRecord.htmlFileName)}" aria-label="Next event: COTD ${nextEventRecord.nr}">&rarr;</a>` : ""}
        </div>
      </div>
      <h2>${escapeHtml(eventRecord.map)}</h2>
      <table>
        <tbody>
          <tr><th>Author</th><td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td></tr>
          <tr><th>Fastest Time</th><td>${eventRecord.fastestTime ? formatRaceTimeHtml(eventRecord.fastestTime) : "-"} by ${renderFastestPlayer(eventRecord, driverFileNames, "..")}</td></tr>
          <tr><th>Podium</th><td>${renderPodium(eventRecord, driverFileNames, "..")}</td></tr>
        </tbody>
      </table>
      <h2>Results</h2>
      <table data-sort-table>
        <thead>
          <tr>
            ${renderSortableHeader("Placing", "placing", "number", "asc", true, "number-cell")}
            ${renderSortableHeader("Player", "driver", "text", "asc")}
            ${renderSortableHeader("Time", "time", "number", "asc", false, "number-cell")}
            ${renderSortableHeader("Elimination Round", "elimination-round", "text", "asc", false, "number-cell")}
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
  driverRatingSummary: Map<string, DriverRatingSummary>,
  driverRatingHistory: Map<string, Map<number, DriverEventRating>>,
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
        driverRatingSummary,
      )}
      ${renderProfileTabs(
        renderRaceResultsSection(
          driverRecord,
          eventRecords,
          authorFileNames,
          driverRatingHistory,
        ),
        renderRaceResultsGraphSection(driverRecord, eventRecords),
        renderPlacingsSection(driverRecord),
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
  driverRatingSummary: Map<string, DriverRatingSummary>,
  driverRatingHistory: Map<string, Map<number, DriverEventRating>>,
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
        driverRatingSummary,
      )}
      ${renderProfileTabs(
        renderRaceResultsSection(
          matchingDriverRecord,
          eventRecords,
          authorFileNames,
          driverRatingHistory,
        ),
        renderRaceResultsGraphSection(matchingDriverRecord, eventRecords),
        renderPlacingsSection(matchingDriverRecord),
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

function buildDriverStats(
  driverRecord: DriverRecord,
  driverRatingSummary: Map<string, DriverRatingSummary>,
): DriverStats {
  const driverResults = getDriverResultRecords(driverRecord);
  const ratingSummary =
    driverRatingSummary.get(driverRecord.canonicalName) ??
    getDefaultDriverRatingSummary();
  const wins = driverResults.filter(
    (entry) => entry.result.placing === 1,
  ).length;
  const podiums = driverResults.filter(
    (entry) => entry.result.placing !== null && entry.result.placing <= 3,
  ).length;
  const starts = driverResults.length;
  const winRate = starts === 0 ? 0 : (wins / starts) * 100;
  const podiumRate = starts === 0 ? 0 : (podiums / starts) * 100;
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
    starts,
    wins,
    winRate,
    podiums,
    podiumRate,
    bestFinish,
    fastestTimes: driverRecord.fastestTimes,
    currentElo: ratingSummary.currentElo,
    peakElo: ratingSummary.peakElo,
  };
}

function getDefaultDriverRatingSummary(): DriverRatingSummary {
  return {
    currentElo: initialElo,
    peakElo: initialElo,
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
    latestEvent: sortedTracks[sortedTracks.length - 1]?.nr ?? null,
  };
}

function renderProfileMetadata(
  driverRecord: DriverRecord | null,
  authorRecord: AuthorRecord | null,
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
  driverRatingSummary: Map<string, DriverRatingSummary>,
): string {
  return `
    <div class="meta-grid">
      ${renderDriverMetadataTable(
        driverRecord,
        authorFileNames,
        rootPrefix,
        driverRatingSummary,
      )}
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
    ${aliasSummary === "-" ? "" : `<div class="aliases"><div>AKA${aliases.length > 10 ? "... where to start?" : ":"}</div><em>${aliasSummary}</em></div>`}
  `;
}

function renderDriverMetadataTable(
  driverRecord: DriverRecord | null,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
  driverRatingSummary: Map<string, DriverRatingSummary>,
): string {
  if (driverRecord === null) {
    return `
      <section>
        <h3>Player</h3>
        <p>No race results found for this name.</p>
      </section>
    `;
  }

  const stats = buildDriverStats(driverRecord, driverRatingSummary);
  const authorPage = authorFileNames.has(driverRecord.canonicalName)
    ? renderAuthorLinks(
        [driverRecord.canonicalName],
        authorFileNames,
        rootPrefix,
      )
    : "-";

  return `
    <section>
      <h3>Player</h3>
      <table>
        <tbody>
          <tr><th>Starts</th><td class="align-right">${stats.starts}</td></tr>
          <tr><th>Wins</th><td class="align-right">${stats.wins}</td></tr>
          <tr><th>Win %</th><td class="align-right">${formatPercentage(stats.winRate)}</td></tr>
          <tr><th>Podiums</th><td class="align-right">${stats.podiums}</td></tr>
          <tr><th>Podium %</th><td class="align-right">${formatPercentage(stats.podiumRate)}</td></tr>
          <tr><th>Best Finish</th><td class="align-right">${stats.bestFinish ?? "-"}</td></tr>
          <tr><th>Fastest Times</th><td class="align-right">${stats.fastestTimes}</td></tr>
          <tr><th>Elo Current</th><td class="align-right">${formatElo(stats.currentElo)}</td></tr>
          <tr><th>Elo Peak</th><td class="align-right">${formatElo(stats.peakElo)}</td></tr>
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
          <tr><th>Tracks</th><td class="align-right">${stats.tracks}</td></tr>
          <tr><th>Solo Tracks</th><td class="align-right">${stats.soloTracks}</td></tr>
          <tr><th>Co-Authored Tracks</th><td class="align-right">${stats.coAuthoredTracks}</td></tr>
          <tr><th>First Event</th><td class="align-right">${stats.firstEvent ?? "-"}</td></tr>
          <tr><th>Latest Event</th><td class="align-right">${stats.latestEvent ?? "-"}</td></tr>
        </tbody>
      </table>
    </section>
  `;
}

function renderProfileTabs(
  raceResultsContent: string,
  raceResultsGraphContent: string,
  placingsContent: string,
  tracksContent: string,
  defaultTab: "race-results" | "race-results-graph" | "placings" | "tracks",
): string {
  return `
    <div class="tab-list" role="tablist" aria-label="Profile sections" data-tabs data-default-tab="${defaultTab}">
      <button type="button" class="tab-button" role="tab" data-tab-target="race-results">Race Results</button>
      <button type="button" class="tab-button" role="tab" data-tab-target="race-results-graph">Results Graph</button>
      <button type="button" class="tab-button" role="tab" data-tab-target="placings">Placings</button>
      <button type="button" class="tab-button" role="tab" data-tab-target="tracks">Tracks</button>
    </div>
    <section id="race-results" class="tab-panel" role="tabpanel">
      ${raceResultsContent}
    </section>
    <section id="race-results-graph" class="tab-panel" role="tabpanel" hidden>
      ${raceResultsGraphContent}
    </section>
    <section id="placings" class="tab-panel" role="tabpanel" hidden>
      ${placingsContent}
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
  driverRatingHistory: Map<string, Map<number, DriverEventRating>>,
): string {
  if (driverRecord === null) {
    return `
      <h2>Race Results</h2>
      <p>No race results found for this name.</p>
    `;
  }

  const ratingHistory =
    driverRatingHistory.get(driverRecord.canonicalName) ?? new Map();
  const driverAuthorFileName =
    authorFileNames.get(driverRecord.canonicalName) ?? null;

  const rows = buildDriverTimeline(driverRecord, eventRecords)
    .map(({ eventRecord, result }) => {
      const ratingAtEvent = ratingHistory.get(eventRecord.nr) ?? null;
      const isTrackAuthor =
        result === null &&
        driverAuthorFileName !== null &&
        eventRecord.authors.some(
          (author) => authorFileNames.get(author) === driverAuthorFileName,
        );
      const rowClasses = [
        result !== null ? buildResultRowClassName(result.placing) : null,
        result === null && isTrackAuthor ? "track-author" : null,
        result === null && !isTrackAuthor ? "did-not-race" : null,
      ]
        .filter((value): value is string => value !== null)
        .join(" ");
      const sortAttributes = renderSortDataAttributes({
        event: normalizeNumberSortValue(eventRecord.nr),
        map: normalizeTextSortValue(eventRecord.map),
        author: normalizeTextSortValue(eventRecord.authors.join(", ")),
        placing: normalizeNumberSortValue(result?.placing),
        time: normalizeTimeSortValue(result?.time),
        "elimination-round": normalizeTextSortValue(result?.eliminationRound),
        elo: normalizeNumberSortValue(ratingAtEvent?.elo),
      });

      return `
        <tr${rowClasses.length > 0 ? ` class="${rowClasses}"` : ""}${sortAttributes}>
          <td><a href="../events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td class="bold"><a href="../events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${result === null ? (isTrackAuthor ? "Track author" : "Did not race") : "Raced"}</td>
          <td class="placings-column align-right number-cell">${result?.placing ?? "-"}</td>
          <td class="align-right number-cell">${result === null ? "-" : formatRaceTimeHtml(result.time)}</td>
          <td class="align-right number-cell">${result?.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
          <td class="align-right number-cell">${ratingAtEvent ? formatElo(ratingAtEvent.elo) : "-"}</td>
        </tr>`;
    })
    .join("\n");

  return `
    <h2>Race Results</h2>
    <table data-sort-table>
      <thead>
        <tr>
          ${renderSortableHeader("Event", "event", "number", "asc", true)}
          ${renderSortableHeader("Track", "map", "text", "asc")}
          ${renderSortableHeader("Author", "author", "text", "asc")}
          <th>Status</th>
          ${renderSortableHeader("Placing", "placing", "number", "asc", false, "placings-column number-cell")}
          ${renderSortableHeader("Time", "time", "number", "asc", false, "number-cell")}
          ${renderSortableHeader("Elimination Round", "elimination-round", "text", "asc", false, "number-cell")}
          ${renderSortableHeader("Elo", "elo", "number", "desc", false, "number-cell")}
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

function renderRaceResultsGraphSection(
  driverRecord: DriverRecord | null,
  eventRecords: EventRecord[],
): string {
  if (driverRecord === null) {
    return `
      <h2>Results Graph</h2>
      <p>No race results found for this name.</p>
    `;
  }

  const series = [
    buildRaceResultsGraphSeries(
      driverRecord,
      eventRecords,
      graphPalette[0],
      null,
    ),
  ];

  return `
    <h2>Results Graph</h2>
    <p class="graph-note">Only top ${graphMaxPlacing} placings are shown directly; anything below that is grouped into ${graphMaxPlacing}+. Breaks indicate no participation.</p>
    ${renderRaceResultsGraphSvg(
      series,
      eventRecords,
      true,
      true,
      series.map((entry) => entry.id),
      null,
    )}
  `;
}

function renderPlacingsSection(driverRecord: DriverRecord | null): string {
  if (driverRecord === null) {
    return `
      <h2>Placings</h2>
      <p>No race results found for this name.</p>
    `;
  }

  const placingCounts = buildPlacingCounts(driverRecord);
  const rows = placingCounts
    .map((count, index) => {
      const placing = index + 1;

      return `
        <tr>
          <th class="align-right">${placing}</th>
          ${renderPlacingCountCell(count, placing)}
        </tr>`;
    })
    .join("\n");

  return `
    <h2>Placings</h2>
    <table class="compact-table placings-table">
      <thead>
        <tr>
          <th class="align-right">Pos</th>
          <th class="align-right">#</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function buildPlacingCounts(driverRecord: DriverRecord): number[] {
  const counts = Array.from({ length: 50 }, () => 0);

  for (const { result } of getDriverResultRecords(driverRecord)) {
    if (result.placing === null || result.placing < 1 || result.placing > 50) {
      continue;
    }

    counts[result.placing - 1] += 1;
  }

  return counts;
}

function buildRaceResultsGraphSeries(
  driverRecord: DriverRecord,
  eventRecords: EventRecord[],
  color: string,
  href: string | null,
): RaceResultsGraphSeries {
  const points = buildDriverTimeline(driverRecord, eventRecords).map(
    ({ eventRecord, result }) => ({
      eventNumber: eventRecord.nr,
      placing:
        result?.placing === null || result?.placing === undefined
          ? null
          : result.placing <= graphMaxPlacing
            ? Math.max(1, result.placing)
            : graphOverflowBucket,
      title:
        result?.placing === null || result?.placing === undefined
          ? `COTD ${eventRecord.nr}: no placing`
          : `${formatPlacingLabel(result.placing)} - COTD ${eventRecord.nr} ${eventRecord.map}`,
      href: `../events/${eventRecord.htmlFileName}`,
    }),
  );

  return {
    id: stableId(driverRecord.canonicalName),
    label: driverRecord.canonicalName,
    color,
    href,
    points,
  };
}

function renderRaceResultsGraphSvg(
  series: RaceResultsGraphSeries[],
  eventRecords: EventRecord[],
  showLines: boolean,
  showPoints: boolean,
  visibleSeriesIds: string[],
  graphId: string | null,
): string {
  if (series.length === 0 || eventRecords.length === 0) {
    return '<p class="graph-empty">No graph data available.</p>';
  }

  const width = 960;
  const height = 380;
  const marginTop = 20;
  const marginRight = 20;
  const marginBottom = 42;
  const marginLeft = 48;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;
  const firstEvent = eventRecords[0]?.nr ?? 1;
  const lastEvent = eventRecords[eventRecords.length - 1]?.nr ?? firstEvent;
  const eventSpan = Math.max(1, lastEvent - firstEvent);
  const yTicks = [1, 3, 6, 10, 15, 20, graphOverflowBucket];
  const xTicks = buildGraphEventTicks(firstEvent, lastEvent);
  const xForEvent = (eventNumber: number): number =>
    marginLeft + ((eventNumber - firstEvent) / eventSpan) * plotWidth;
  const yForPlacing = (placing: number): number =>
    marginTop + ((placing - 1) / (graphOverflowBucket - 1)) * plotHeight;

  const yGrid = yTicks
    .map((placing) => {
      const y = yForPlacing(placing);
      const label =
        placing === graphOverflowBucket
          ? `${graphMaxPlacing}+`
          : String(placing);

      return `
        <line class="graph-grid" x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}"></line>
        <text class="graph-label" x="${marginLeft - 10}" y="${y + 4}" text-anchor="end">${label}</text>`;
    })
    .join("\n");

  const xGrid = xTicks
    .map((eventNumber) => {
      const x = xForEvent(eventNumber);

      return `
        <line class="graph-grid" x1="${x}" y1="${marginTop}" x2="${x}" y2="${height - marginBottom}"></line>
        <text class="graph-label" x="${x}" y="${height - marginBottom + 18}" text-anchor="middle">${eventNumber}</text>`;
    })
    .join("\n");

  const paths = series
    .map((entry, seriesIndex) => {
      const isVisible = visibleSeriesIds.includes(entry.id);
      const segments = buildGraphSegments(entry.points);
      const pathMarkup = showLines
        ? segments
            .map((segment) => {
              const pathData = segment
                .map((point, index) => {
                  const x = xForEvent(point.eventNumber);
                  const y = yForPlacing(point.placing);

                  return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
                })
                .join(" ");

              return `<path class="graph-line graph-series-${seriesIndex}" d="${pathData}" stroke="${entry.color}"></path>`;
            })
            .join("\n")
        : "";
      const pointMarkup = showPoints
        ? entry.points
            .filter(
              (point): point is RaceResultsGraphPoint & { placing: number } =>
                point.placing !== null,
            )
            .map((point) => {
              const x = xForEvent(point.eventNumber);
              const y = yForPlacing(point.placing);
              const title = escapeHtml(`${entry.label} - ${point.title}`);
              const circleMarkup = `<circle class="graph-point" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="${entry.color}"><title>${title}</title></circle>`;

              if (!point.href) {
                return circleMarkup;
              }

              return `<a href="${escapeHtml(point.href)}" aria-label="${title}">${circleMarkup}</a>`;
            })
            .join("\n")
        : "";

      return `<g class="graph-series${isVisible ? "" : " is-hidden"}" data-graph-series="${escapeHtml(entry.id)}">${pathMarkup}\n${pointMarkup}</g>`;
    })
    .join("\n");
  const graphRootAttribute =
    graphId === null ? "" : ` data-graph-root="${escapeHtml(graphId)}"`;

  return `
    <div class="graph-card">
      <svg class="graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Results graph"${graphRootAttribute}>
        ${yGrid}
        ${xGrid}
        <line class="graph-axis" x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${height - marginBottom}"></line>
        <line class="graph-axis" x1="${marginLeft}" y1="${height - marginBottom}" x2="${width - marginRight}" y2="${height - marginBottom}"></line>
        <text class="graph-label" x="${width / 2}" y="${height - 8}" text-anchor="middle">Event</text>
        <text class="graph-label" x="18" y="${height / 2}" text-anchor="middle" transform="rotate(-90 18 ${height / 2})">Placing</text>
        ${paths}
      </svg>
    </div>
  `;
}

function buildGraphSegments(
  points: RaceResultsGraphPoint[],
): Array<Array<RaceResultsGraphPoint & { placing: number }>> {
  const segments: Array<Array<RaceResultsGraphPoint & { placing: number }>> =
    [];
  let currentSegment: Array<RaceResultsGraphPoint & { placing: number }> = [];

  for (const point of points) {
    if (point.placing === null) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }

      continue;
    }

    currentSegment.push({ ...point, placing: point.placing });
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function buildGraphEventTicks(firstEvent: number, lastEvent: number): number[] {
  const ticks = new Set<number>([firstEvent, lastEvent]);

  for (
    let eventNumber = Math.ceil(firstEvent / 10) * 10;
    eventNumber < lastEvent;
    eventNumber += 10
  ) {
    ticks.add(eventNumber);
  }

  return Array.from(ticks).sort((left, right) => left - right);
}

function renderRaceResultsGraphSelector(
  series: RaceResultsGraphSeries[],
  defaultVisibleIds: string[],
): string {
  if (series.length === 0) {
    return '<p class="graph-empty">No player graph data is available.</p>';
  }

  const quickPickOptions = series
    .map(
      (entry) =>
        `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`,
    )
    .join("\n");
  const quickPicks = Array.from(
    { length: combinedGraphQuickPickCount },
    (_, index) => {
      const selectedId = defaultVisibleIds[index] ?? "";
      const slotColor = graphPalette[index % graphPalette.length] ?? "#0047ab";
      const options =
        selectedId.length === 0
          ? quickPickOptions
          : quickPickOptions.replace(
              `value="${escapeHtml(selectedId)}"`,
              `value="${escapeHtml(selectedId)}" selected`,
            );

      return `
        <label class="graph-select-item">
          <span class="graph-select-label">Player ${index + 1}</span>
          <input class="graph-select-filter" data-graph-select-filter type="search" placeholder="Filter players">
          <span class="graph-select-row">
            <span class="graph-swatch graph-select-swatch" data-graph-select-swatch style="background:${slotColor}"></span>
            <select class="graph-select" data-graph-select data-graph-slot-color="${slotColor}">
              <option value="">None</option>
              ${options}
            </select>
          </span>
        </label>`;
    },
  ).join("\n");

  return `
    <div class="graph-controls" data-graph-picker data-graph-target="combined-race-results">
      <p class="graph-note">The top ${combinedGraphDefaultSelectionCount} players are enabled by default. Each dropdown includes every player.</p>
      <div class="graph-select-list">
        ${quickPicks}
      </div>
    </div>`;
}

function getDriverWinCount(driverRecord: DriverRecord): number {
  return getDriverResultRecords(driverRecord).filter(
    (entry) => entry.result.placing === 1,
  ).length;
}

function buildResultRowClassName(placing: number | null): string {
  const classes = ["result"];

  if (placing !== null && placing >= 1 && placing <= 25) {
    classes.push(`result-${placing}`);
  }

  return classes.join(" ");
}

function renderZeroValueCountCell(count: number): string {
  if (count === 0) {
    return '<td class="align-right is-zero"></td>';
  }

  return `<td class="align-right">${count}</td>`;
}

function renderPlacingCountCell(count: number, placing: number): string {
  const classes = ["placingNo", "align-right", "bold"];

  if (placing >= 1 && placing <= 25) {
    classes.push(`placing-${placing}`);
  }

  if (count === 0) {
    classes.push("is-zero");
    return `<td class="${classes.join(" ")}"></td>`;
  }

  return `<td class="${classes.join(" ")}">${count}</td>`;
}

function renderZeroValuePercentageCell(value: number): string {
  if (value === 0) {
    return '<td class="align-right is-zero"></td>';
  }

  return `<td class="align-right">${formatPercentage(value)}</td>`;
}

function formatRaceTimeHtml(value: string): string {
  if (/^dnf$/i.test(value.trim())) {
    return "<small>DNF</small>";
  }

  return formatDecimalHtml(value);
}

function formatDecimalHtml(value: string): string {
  const match = value.match(/^(.*?)([.,])(\d+)$/);

  if (!match) {
    return escapeHtml(value);
  }

  const [, wholePart, separator, fractionalPart] = match;
  return `${escapeHtml(wholePart)}${separator}<small>${escapeHtml(fractionalPart)}</small>`;
}

function renderFastestPlayer(
  eventRecord: EventRecord,
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (!eventRecord.fastestTimeDriver) {
    return "-";
  }

  const playerMarkup = renderDriverLink(
    eventRecord.fastestTimeDriver,
    driverFileNames,
    rootPrefix,
  );
  const fastestRound = getFastestRound(eventRecord);
  const totalRounds = getEventTotalRounds(eventRecord);

  if (fastestRound !== null && totalRounds !== null) {
    return `${playerMarkup} <small>(round ${fastestRound}/${totalRounds})</small>`;
  }

  if (fastestRound !== null) {
    return `${playerMarkup} <small>(round ${fastestRound})</small>`;
  }

  return playerMarkup;
}

function getFastestRound(eventRecord: EventRecord): number | null {
  const explicitRound = parseRoundNumber(eventRecord.fastestTimeRound);

  if (explicitRound !== null) {
    return explicitRound;
  }

  const runnerUp = eventRecord.results.find((result) => result.placing === 2);
  return parseRoundNumber(runnerUp?.eliminationRound);
}

function getEventTotalRounds(eventRecord: EventRecord): number | null {
  const roundNumbers = [
    getFastestRound(eventRecord),
    ...eventRecord.results.map((result) =>
      parseRoundNumber(result.eliminationRound),
    ),
  ].filter((value): value is number => value !== null);

  if (roundNumbers.length === 0) {
    return null;
  }

  return Math.max(...roundNumbers);
}

function parseRoundNumber(value: string | null | undefined): number | null {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return null;
  }

  const match = normalized.match(/\d+/);

  if (!match) {
    return null;
  }

  return Number(match[0]);
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
      const sortAttributes = renderSortDataAttributes({
        event: normalizeNumberSortValue(eventRecord.nr),
        map: normalizeTextSortValue(eventRecord.map),
        authors: normalizeTextSortValue(eventRecord.authors.join(", ")),
        winner: normalizeTextSortValue(
          winners.map((result) => result.name).join(", "),
        ),
        "fastest-time": normalizeTimeSortValue(eventRecord.fastestTime),
        "fastest-driver": normalizeTextSortValue(eventRecord.fastestTimeDriver),
      });

      return `
        <tr${sortAttributes}>
          <td><a href="../events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td class="bold"><a href="../events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${renderDriverList(winners, driverFileNames, "..")}</td>
          <td class="align-right">${eventRecord.fastestTime ? formatRaceTimeHtml(eventRecord.fastestTime) : "-"}</td>
          <td>${renderFastestPlayer(eventRecord, driverFileNames, "..")}</td>
        </tr>`;
    })
    .join("\n");

  return `
    <h2>Tracks</h2>
    <table data-sort-table>
      <thead>
        <tr>
          ${renderSortableHeader("Event", "event", "number", "asc", true)}
          ${renderSortableHeader("Track", "map", "text", "asc")}
          ${renderSortableHeader("All Authors", "authors", "text", "asc")}
          ${renderSortableHeader("Winner", "winner", "text", "asc")}
          ${renderSortableHeader("Fastest Time", "fastest-time", "number", "asc")}
          ${renderSortableHeader("Fastest Player", "fastest-driver", "text", "asc")}
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
        `${group.placing}. ${renderDriverList(group.entries, driverFileNames, rootPrefix)}`,
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

            driverSearchSummary.textContent = visibleCount + " player" + (visibleCount === 1 ? "" : "s") + " shown";
          };

          driverSearchInput.addEventListener("input", updateDriverFilter);
          updateDriverFilter();
        }

        for (const picker of document.querySelectorAll("[data-graph-picker]")) {
          const graphTarget = picker.getAttribute("data-graph-target") || "";
          const selects = Array.from(
            picker.querySelectorAll("[data-graph-select]"),
          );
          const optionSets = new Map(
            selects.map((select) => [
              select,
              Array.from(select.querySelectorAll("option")).map((option) => ({
                value: option.value,
                label: option.textContent || "",
              })),
            ]),
          );

          if (!graphTarget || selects.length === 0) {
            continue;
          }

          const graphRoot = document.querySelector(
            '[data-graph-root="' + graphTarget + '"]',
          );

          const updateSelectOptions = (select, query) => {
            const optionSet = optionSets.get(select) || [];
            const selectedValue = select.value;
            const normalizedQuery = (query || "").trim().toLowerCase();
            const matchingOptions = optionSet.filter((option) => {
              if (option.value === "") {
                return true;
              }

              if (option.value === selectedValue) {
                return true;
              }

              return (
                normalizedQuery.length === 0 ||
                option.label.toLowerCase().includes(normalizedQuery)
              );
            });

            select.innerHTML = matchingOptions
              .map((option) => {
                const selectedAttribute =
                  option.value === selectedValue ? " selected" : "";

                return '<option value="' + option.value + '"' + selectedAttribute + '>' + option.label + '</option>';
              })
              .join("");

            select.value = selectedValue;
          };

          const updateGraphSelection = () => {
            const selectedIds = new Set();
            const selectedColors = new Map();

            for (const select of selects) {
              const swatch = select
                .closest(".graph-select-item")
                ?.querySelector("[data-graph-select-swatch]");
              const slotColor =
                select.getAttribute("data-graph-slot-color") || "#0047ab";

              if (swatch) {
                swatch.style.background = slotColor;
              }

              if (select.value) {
                selectedIds.add(select.value);

                if (!selectedColors.has(select.value)) {
                  selectedColors.set(select.value, slotColor);
                }
              }
            }

            if (!graphRoot) {
              return;
            }

            for (const seriesGroup of graphRoot.querySelectorAll("[data-graph-series]")) {
              const seriesId = seriesGroup.getAttribute("data-graph-series") || "";
              seriesGroup.classList.toggle("is-hidden", !selectedIds.has(seriesId));

              const seriesColor = selectedColors.get(seriesId) || "#0047ab";

              for (const path of seriesGroup.querySelectorAll(".graph-line")) {
                path.setAttribute("stroke", seriesColor);
              }

              for (const point of seriesGroup.querySelectorAll(".graph-point")) {
                point.setAttribute("fill", seriesColor);
              }
            }
          };

          for (const select of selects) {
            const filterInput = select
              .closest(".graph-select-item")
              ?.querySelector("[data-graph-select-filter]");

            if (filterInput) {
              filterInput.addEventListener("input", () => {
                updateSelectOptions(select, filterInput.value);
              });
            }

            select.addEventListener("change", updateGraphSelection);
            updateSelectOptions(select, filterInput?.value || "");
          }

          updateGraphSelection();
        }

        for (const table of document.querySelectorAll("[data-sort-table]")) {
          const tbody = table.tBodies[0];

          if (!tbody) {
            continue;
          }

          const sorters = Array.from(table.querySelectorAll(".sorter[data-sort-key]"));

          if (sorters.length === 0) {
            continue;
          }

          const updateSorterState = (activeSorter, direction) => {
            for (const sorter of sorters) {
              const isActive = sorter === activeSorter;
              sorter.classList.toggle("active", isActive);
              sorter.dataset.sortDirection = isActive ? direction : "";
              sorter.setAttribute("aria-pressed", String(isActive));

              const indicator = sorter.querySelector(".sort-indicator");
              if (indicator) {
                indicator.textContent = isActive
                  ? direction === "asc"
                    ? "▲"
                    : "▼"
                  : "↕";
              }

              const headerCell = sorter.closest("th");
              if (headerCell) {
                headerCell.setAttribute(
                  "aria-sort",
                  isActive
                    ? direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none",
                );
              }
            }
          };

          const sortRows = (sorter, direction) => {
            const sortKey = sorter.dataset.sortKey;
            const sortType = sorter.dataset.sortType || "text";

            if (!sortKey) {
              return;
            }

            const rows = Array.from(tbody.querySelectorAll("tr")).map((row, index) => ({
              row,
              index,
            }));

            rows.sort((left, right) => {
              const leftValue = left.row.getAttribute("data-sort-" + sortKey) || "";
              const rightValue = right.row.getAttribute("data-sort-" + sortKey) || "";
              const leftEmpty = leftValue.length === 0;
              const rightEmpty = rightValue.length === 0;

              if (leftEmpty || rightEmpty) {
                if (leftEmpty && rightEmpty) {
                  return left.index - right.index;
                }

                return leftEmpty ? 1 : -1;
              }

              let comparison = 0;

              if (sortType === "number") {
                comparison = Number(leftValue) - Number(rightValue);
              } else {
                comparison = leftValue.localeCompare(rightValue, undefined, {
                  numeric: true,
                  sensitivity: "base",
                });
              }

              if (comparison === 0) {
                comparison = left.index - right.index;
              }

              return direction === "asc" ? comparison : -comparison;
            });

            tbody.append(...rows.map((entry) => entry.row));
            updateSorterState(sorter, direction);
          };

          const initialSorter = sorters.find((sorter) => sorter.classList.contains("active")) || sorters[0];

          if (initialSorter) {
            sortRows(
              initialSorter,
              initialSorter.dataset.sortDefaultDirection || "asc",
            );
          }

          for (const sorter of sorters) {
            sorter.addEventListener("click", (event) => {
              event.preventDefault();

              const nextDirection = sorter.classList.contains("active")
                ? sorter.dataset.sortDirection === "asc"
                  ? "desc"
                  : "asc"
                : sorter.dataset.sortDefaultDirection || "asc";

              sortRows(sorter, nextDirection);
            });
          }
        }
      });
    </script>
  </head>
  <body>
    <nav>
      <a href="${options.rootPrefix}/index.html">Overview</a>
      <a href="${options.rootPrefix}/drivers/index.html">Players</a>
      <a href="${options.rootPrefix}/placings/index.html">Placings</a>
      <a href="${options.rootPrefix}/race-results-graph/index.html">Results Graph</a>
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

function formatPercentage(value: number): string {
  return `${formatDecimalHtml(value.toFixed(1))}<small>%</small>`;
}

function formatPlacingLabel(value: number): string {
  const mod100 = value % 100;

  if (mod100 >= 11 && mod100 <= 13) {
    return `${value}th`;
  }

  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function formatElo(value: number): string {
  return Math.round(value).toString();
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
