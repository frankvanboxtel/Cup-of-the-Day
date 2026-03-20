import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type CompetitionType = "cotd" | "roulette" | "troll";

type ResultEntry = {
  placing: number | null;
  name: string;
  time: string;
  eliminationRound: string | null;
  rouletteMap: string | null;
  rouletteMapper: string | null;
  rouletteSourceEventNumber: number | null;
};

type CupResultFile = {
  competitionType: CompetitionType;
  competitionLabel: string;
  eventLabel: string;
  nr: number;
  map: string;
  author: string;
  description: string | null;
  fastestTime: string | null;
  fastestTimeDriver: string | null;
  fastestTimeRound: string | null;
  rouletteSourceLabel: string | null;
  sourceFile: string;
  results: ResultEntry[];
};

type AliasList = Record<string, string[]>;
type DisplayOnlyNameList = string[];

type AliasResolver = {
  canonicalByName: Map<string, string>;
  aliasesByCanonical: Map<string, string[]>;
};

type EventRecord = CupResultFile & {
  eventKey: string;
  sortOrder: number;
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
  top6: number;
  top6Rate: number;
  top10: number;
  top10Rate: number;
  top25: number;
  top25Rate: number;
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
  history: Map<string, Map<string, DriverEventRating>>;
};

type CompetitionDefinition = {
  type: CompetitionType;
  label: string;
  shortLabel: string;
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "data", "generated-jsons");
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
const playerDataDirectory = path.join(projectRoot, "data", "player-settings");
const manualAliasListPath = path.join(
  playerDataDirectory,
  "player-aliases.json",
);
const generatedAliasListPath = path.join(
  playerDataDirectory,
  "player-aliases.generated.json",
);
const displayOnlyNameListPath = path.join(
  playerDataDirectory,
  "display-only-names.json",
);
const initialElo = 1500;
const eloKFactor = 32;
const graphMaxPlacing = 20;
const graphOverflowBucket = graphMaxPlacing + 1;
const combinedGraphDefaultSelectionCount = 3;
const combinedGraphQuickPickCount = 10;
const competitionDefinitions: CompetitionDefinition[] = [
  {
    type: "cotd",
    label: "Cup of the Day",
    shortLabel: "COTD",
  },
  {
    type: "roulette",
    label: "Cup of the Day Roulette",
    shortLabel: "Roulette",
  },
  {
    type: "troll",
    label: "Troll Cup of the Day",
    shortLabel: "Troll COTD",
  },
];
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
  const displayOnlyNames = await loadDisplayOnlyNames();
  const eventRecords = await loadEventRecords();
  const cotdEventRecordsByNumber = new Map(
    getCompetitionEventRecords(eventRecords, "cotd").map((eventRecord) => [
      eventRecord.nr,
      eventRecord,
    ]),
  );
  const ratedEventRecords = eventRecords.filter(
    (eventRecord) => eventRecord.competitionType === "cotd",
  );
  const eventRatings = buildEventRatings(
    ratedEventRecords,
    aliasResolver,
    displayOnlyNames,
  );
  const driverRatingHistory = eventRatings.history;
  const driverRecords = buildDriverRecords(
    eventRecords,
    aliasResolver,
    displayOnlyNames,
  );
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
    ...buildEventNavigationPairs(eventRecords).map(
      ({ eventRecord, previousEventRecord, nextEventRecord }) =>
        writeEventPage(
          eventRecord,
          driverFileNames,
          authorFileNames,
          cotdEventRecordsByNumber,
          previousEventRecord,
          nextEventRecord,
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
        fileName !== "player-alias-proposals.json",
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
      const authors =
        parsed.competitionType === "roulette"
          ? getRouletteAuthors(filteredResults)
          : splitAuthors(parsed.author);

      return {
        ...parsed,
        eventKey: buildEventKey(parsed.competitionType, parsed.nr),
        sortOrder: 0,
        results: filteredResults,
        jsonFileName: fileName,
        htmlFileName: `${path.basename(fileName, ".json")}.html`,
        podium: buildPodium(filteredResults),
        authors,
      } satisfies EventRecord;
    }),
  );

  return records.sort(compareEventRecords).map((record, index) => ({
    ...record,
    sortOrder: index + 1,
  }));
}

function buildEventNavigationPairs(eventRecords: EventRecord[]): Array<{
  eventRecord: EventRecord;
  previousEventRecord: EventRecord | null;
  nextEventRecord: EventRecord | null;
}> {
  return competitionDefinitions.flatMap(({ type }) => {
    const competitionEvents = eventRecords.filter(
      (eventRecord) => eventRecord.competitionType === type,
    );

    return competitionEvents.map((eventRecord, index) => ({
      eventRecord,
      previousEventRecord: competitionEvents[index - 1] ?? null,
      nextEventRecord: competitionEvents[index + 1] ?? null,
    }));
  });
}

function getRouletteAuthors(results: ResultEntry[]): string[] {
  return Array.from(
    new Set(
      results
        .map((result) => normalizeWhitespace(result.rouletteMapper ?? ""))
        .filter((mapper) => mapper.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function buildEventKey(
  competitionType: CompetitionType,
  eventNumber: number,
): string {
  return `${competitionType}:${eventNumber}`;
}

function compareEventRecords(left: EventRecord, right: EventRecord): number {
  return (
    getCompetitionOrder(left.competitionType) -
      getCompetitionOrder(right.competitionType) ||
    left.nr - right.nr ||
    left.eventLabel.localeCompare(right.eventLabel)
  );
}

function getCompetitionDefinition(
  competitionType: CompetitionType,
): CompetitionDefinition {
  return (
    competitionDefinitions.find(
      (definition) => definition.type === competitionType,
    ) ?? {
      type: competitionType,
      label: competitionType,
      shortLabel: competitionType,
    }
  );
}

function getCompetitionOrder(competitionType: CompetitionType): number {
  return competitionDefinitions.findIndex(
    (definition) => definition.type === competitionType,
  );
}

function getCompetitionEventRecords(
  eventRecords: EventRecord[],
  competitionType: CompetitionType,
): EventRecord[] {
  return eventRecords.filter(
    (eventRecord) => eventRecord.competitionType === competitionType,
  );
}

function renderEventLink(
  eventRecord: EventRecord,
  rootPrefix: string,
  label = eventRecord.eventLabel,
): string {
  return `<a href="${rootPrefix}/events/${eventRecord.htmlFileName}">${escapeHtml(label)}</a>`;
}

function renderEventMapLink(
  eventRecord: EventRecord,
  rootPrefix: string,
  label = eventRecord.map,
): string {
  return `<a href="${rootPrefix}/events/${eventRecord.htmlFileName}">${escapeHtml(label)}</a>`;
}

function renderEventAuthors(
  eventRecord: EventRecord,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
  compact = false,
): string {
  if (compact && eventRecord.competitionType === "roulette") {
    return escapeHtml(eventRecord.author);
  }

  return renderAuthorLinks(eventRecord.authors, authorFileNames, rootPrefix);
}

function renderFastestTimeSummary(
  eventRecord: EventRecord,
  driverFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (!eventRecord.fastestTime) {
    return "-";
  }

  const fastestPlayer = renderFastestPlayer(
    eventRecord,
    driverFileNames,
    rootPrefix,
  );

  if (fastestPlayer === "-") {
    return formatRaceTimeHtml(eventRecord.fastestTime);
  }

  return `${formatRaceTimeHtml(eventRecord.fastestTime)} by ${fastestPlayer}`;
}

function renderTabPanels(
  tabPrefix: string,
  tabs: Array<{ suffix: string; label: string; content: string }>,
  defaultSuffix: string,
  ariaLabel: string,
): string {
  return `
    <div class="tab-list" role="tablist" aria-label="${escapeHtml(ariaLabel)}" data-tabs data-default-tab="${escapeHtml(`${tabPrefix}-${defaultSuffix}`)}">
      ${tabs
        .map(
          (tab) =>
            `<button type="button" class="tab-button" role="tab" data-tab-target="${escapeHtml(`${tabPrefix}-${tab.suffix}`)}">${escapeHtml(tab.label)}</button>`,
        )
        .join("\n")}
    </div>
    ${tabs
      .map(
        (tab, index) => `
          <section id="${escapeHtml(`${tabPrefix}-${tab.suffix}`)}" class="tab-panel" role="tabpanel"${index === 0 ? "" : " hidden"}>
            ${tab.content}
          </section>`,
      )
      .join("\n")}
  `;
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

async function loadDisplayOnlyNames(): Promise<Set<string>> {
  const content = await readFile(displayOnlyNameListPath, "utf8");
  const names = JSON.parse(content) as DisplayOnlyNameList;

  return new Set(names.map(normalizeDisplayOnlyName).filter(Boolean));
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

function normalizeDisplayOnlyName(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
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

function isDisplayOnlyName(
  name: string,
  aliasResolver: AliasResolver,
  displayOnlyNames: Set<string>,
): boolean {
  const normalizedName = normalizeWhitespace(name);
  const canonicalName = resolveAlias(normalizedName, aliasResolver);

  return (
    displayOnlyNames.has(normalizeDisplayOnlyName(normalizedName)) ||
    displayOnlyNames.has(normalizeDisplayOnlyName(canonicalName))
  );
}

function buildDriverRecords(
  eventRecords: EventRecord[],
  aliasResolver: AliasResolver,
  displayOnlyNames: Set<string>,
): DriverRecord[] {
  const driverRecords = new Map<string, DriverRecord>();

  for (const eventRecord of eventRecords) {
    for (const result of eventRecord.results) {
      if (isDisplayOnlyName(result.name, aliasResolver, displayOnlyNames)) {
        continue;
      }

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
      if (
        isDisplayOnlyName(
          eventRecord.fastestTimeDriver,
          aliasResolver,
          displayOnlyNames,
        )
      ) {
        continue;
      }

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
      results: [...driverRecord.results].sort((left, right) =>
        compareEventRecords(left.eventRecord, right.eventRecord),
      ),
    }))
    .sort((left, right) =>
      left.canonicalName.localeCompare(right.canonicalName),
    );
}

function buildEventRatings(
  eventRecords: EventRecord[],
  aliasResolver: AliasResolver,
  displayOnlyNames: Set<string>,
): EventRatings {
  const elo = new Map<string, number>();
  const summary = new Map<string, DriverRatingSummary>();
  const history = new Map<string, Map<string, DriverEventRating>>();

  for (const eventRecord of eventRecords) {
    const participants = buildCanonicalEventResults(
      eventRecord,
      aliasResolver,
      displayOnlyNames,
    );

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

      history.get(participant.canonicalName)?.set(eventRecord.eventKey, {
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
  displayOnlyNames: Set<string>,
): CanonicalEventResult[] {
  const byDriver = new Map<string, CanonicalEventResult>();

  for (const result of eventRecord.results) {
    if (isDisplayOnlyName(result.name, aliasResolver, displayOnlyNames)) {
      continue;
    }

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
        !authorRecord.tracks.some(
          (track) => track.eventKey === eventRecord.eventKey,
        )
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
      tracks: [...authorRecord.tracks].sort(compareEventRecords),
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
  const tabs = competitionDefinitions.map((definition) => ({
    suffix: definition.type,
    label: definition.label,
    content: renderOverviewCompetitionSection(
      getCompetitionEventRecords(eventRecords, definition.type),
      driverFileNames,
      authorFileNames,
      ".",
    ),
  }));

  const content = renderLayout(
    "Cup of the Day",
    `
      <h1>Cup Competitions</h1>
      <p>${eventRecords.length} events across ${competitionDefinitions.length} competitions.</p>
      ${renderTabPanels("overview", tabs, competitionDefinitions[0]?.type ?? "cotd", "Overview competitions")}
    `,
    {
      pageTitle: "Cup of the Day Overview",
      rootPrefix: ".",
    },
  );

  await writeFile(indexFilePath, content, "utf8");
}

function renderOverviewCompetitionSection(
  eventRecords: EventRecord[],
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
  rootPrefix: string,
): string {
  if (eventRecords.length === 0) {
    return "<p>No events found for this competition.</p>";
  }

  const rows = eventRecords
    .map((eventRecord) => {
      const podium = renderPodium(eventRecord, driverFileNames, rootPrefix);
      const authors = renderEventAuthors(
        eventRecord,
        authorFileNames,
        rootPrefix,
        true,
      );
      const fastestDriver = renderFastestPlayer(
        eventRecord,
        driverFileNames,
        rootPrefix,
      );
      const sortAttributes = renderSortDataAttributes({
        event: eventRecord.nr,
        map: normalizeTextSortValue(eventRecord.map),
        author: normalizeTextSortValue(
          eventRecord.competitionType === "roulette"
            ? eventRecord.author
            : eventRecord.authors.join(", "),
        ),
        "fastest-time": normalizeTimeSortValue(eventRecord.fastestTime),
        "fastest-driver": normalizeTextSortValue(eventRecord.fastestTimeDriver),
      });

      return `
        <tr${sortAttributes}>
          <td class="number-cell">${renderEventLink(eventRecord, rootPrefix)}</td>
          <td class="bold">${renderEventMapLink(eventRecord, rootPrefix)}</td>
          <td>${authors}</td>
          <td class="align-right number-cell">${eventRecord.fastestTime ? formatRaceTimeHtml(eventRecord.fastestTime) : "-"}</td>
          <td>${fastestDriver}</td>
          <td>${podium}</td>
        </tr>`;
    })
    .join("\n");

  return `
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
  `;
}

function renderCompetitionFilterPanel(
  filterTarget: string,
  legend = "Competitions",
): string {
  return `
    <fieldset class="competition-filter-panel" data-competition-filter-group data-competition-filter-target="${escapeHtml(filterTarget)}">
      <legend>${escapeHtml(legend)}</legend>
      <div class="competition-filter-options">
        ${competitionDefinitions
          .map(
            (definition) => `
              <label class="competition-filter-option">
                <input type="checkbox" data-competition-toggle value="${escapeHtml(definition.type)}" checked>
                <span>${escapeHtml(definition.label)}</span>
              </label>`,
          )
          .join("\n")}
      </div>
    </fieldset>
  `;
}

function renderCompetitionMetricAttributes(
  metrics: Record<string, Partial<Record<CompetitionType, number>>>,
): string {
  return Object.entries(metrics)
    .map(([metricKey, valuesByCompetition]) =>
      competitionDefinitions
        .map(
          ({ type }) =>
            ` data-stats-${type}-${metricKey}="${valuesByCompetition[type] ?? 0}"`,
        )
        .join(""),
    )
    .join("");
}

function renderDynamicCompetitionCountCell(
  metricKey: string,
  value: number,
  additionalClasses = "",
): string {
  const classNames = [
    "align-right",
    additionalClasses,
    value === 0 ? "is-zero" : "",
  ]
    .filter((value) => value.length > 0)
    .join(" ");

  return `<td class="${classNames}" data-competition-cell="${escapeHtml(metricKey)}">${value === 0 ? "" : value}</td>`;
}

function renderDynamicCompetitionPercentageCell(
  metricKey: string,
  value: number,
): string {
  return `<td class="align-right${value === 0 ? " is-zero" : ""}" data-competition-cell="${escapeHtml(metricKey)}">${value === 0 ? "" : formatPercentage(value)}</td>`;
}

function buildAuthorTrackCountsByCompetition(
  authorRecord: AuthorRecord | null,
): Record<CompetitionType, number> {
  return Object.fromEntries(
    competitionDefinitions.map(({ type }) => [
      type,
      authorRecord?.tracks.filter(
        (eventRecord) => eventRecord.competitionType === type,
      ).length ?? 0,
    ]),
  ) as Record<CompetitionType, number>;
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
      const tracksByCompetition = buildAuthorTrackCountsByCompetition(
        authorRecordsByName.get(driverRecord.canonicalName) ?? null,
      );
      const statsByCompetition = Object.fromEntries(
        competitionDefinitions.map(({ type }) => [
          type,
          buildDriverStats(driverRecord, driverRatingSummary, [type]),
        ]),
      ) as Record<CompetitionType, DriverStats>;
      const tracksCreated = Object.values(tracksByCompetition).reduce(
        (sum, count) => sum + count,
        0,
      );
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
      const competitionAttributes = renderCompetitionMetricAttributes({
        tracks: tracksByCompetition,
        starts: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].starts,
          ]),
        ),
        wins: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].wins,
          ]),
        ),
        podiums: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].podiums,
          ]),
        ),
        "fastest-times": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].fastestTimes,
          ]),
        ),
      });

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}"${sortAttributes}${competitionAttributes}>
          <td><a href="${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(driverRecord.canonicalName)}</a></td>
          <td title="${driverRecord.aliases.join(", ")}"><div class="single-line alias">${aliasSummary}</div></td>
          ${renderDynamicCompetitionCountCell("tracks", tracksCreated)}
          ${renderDynamicCompetitionCountCell("starts", stats.starts)}
          ${renderDynamicCompetitionCountCell("wins", stats.wins)}
          ${renderDynamicCompetitionPercentageCell("win-rate", stats.winRate)}
          ${renderDynamicCompetitionCountCell("podiums", stats.podiums)}
          ${renderDynamicCompetitionPercentageCell("podium-rate", stats.podiumRate)}
          ${renderDynamicCompetitionCountCell("fastest-times", stats.fastestTimes)}
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
      ${renderCompetitionFilterPanel("players-index", "Include competitions in totals")}
      <table data-sort-table data-competition-stats-table="players" data-competition-filter-target="players-index">
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
      const statsByCompetition = Object.fromEntries(
        competitionDefinitions.map(({ type }) => [
          type,
          buildDriverStats(driverRecord, driverRatingSummary, [type]),
        ]),
      ) as Record<CompetitionType, DriverStats>;
      const placingCounts = buildPlacingCounts(driverRecord);
      const placingSummary = summarizePlacingCounts(placingCounts);
      const placingCountsByCompetition = Object.fromEntries(
        competitionDefinitions.map(({ type }) => [
          type,
          buildPlacingCountsForCompetitions(driverRecord, [type]),
        ]),
      ) as Record<CompetitionType, number[]>;
      const sortAttributes = renderSortDataAttributes({
        driver: normalizeTextSortValue(driverRecord.canonicalName),
        starts: normalizeNumberSortValue(stats.starts),
        wins: normalizeNumberSortValue(stats.wins),
        finals: normalizeNumberSortValue(placingSummary.finals),
        podiums: normalizeNumberSortValue(placingSummary.podiums),
        "top-6": normalizeNumberSortValue(placingSummary.top6),
        "top-10": normalizeNumberSortValue(placingSummary.top10),
        "top-25": normalizeNumberSortValue(placingSummary.top25),
        ...Object.fromEntries(
          placingColumns.map((placing) => [
            `placing-${placing}`,
            normalizeNumberSortValue(placingCounts[placing - 1] ?? 0),
          ]),
        ),
      });
      const competitionAttributes = renderCompetitionMetricAttributes({
        starts: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].starts,
          ]),
        ),
        wins: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            placingCountsByCompetition[type][0] ?? 0,
          ]),
        ),
        finals: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            summarizePlacingCounts(placingCountsByCompetition[type]).finals,
          ]),
        ),
        podiums: Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            summarizePlacingCounts(placingCountsByCompetition[type]).podiums,
          ]),
        ),
        "top-6": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            summarizePlacingCounts(placingCountsByCompetition[type]).top6,
          ]),
        ),
        "top-10": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            summarizePlacingCounts(placingCountsByCompetition[type]).top10,
          ]),
        ),
        "top-25": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            summarizePlacingCounts(placingCountsByCompetition[type]).top25,
          ]),
        ),
        ...Object.fromEntries(
          placingColumns.map((placing) => [
            `placing-${placing}`,
            Object.fromEntries(
              competitionDefinitions.map(({ type }) => [
                type,
                placingCountsByCompetition[type][placing - 1] ?? 0,
              ]),
            ),
          ]),
        ),
      });
      const placingCells = placingColumns
        .map((placing) =>
          renderDynamicCompetitionCountCell(
            `placing-${placing}`,
            placingCounts[placing - 1] ?? 0,
            `placingNo bold${placing >= 1 && placing <= 25 ? ` placing-${placing}` : ""}`,
          ),
        )
        .join("");

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}"${sortAttributes}${competitionAttributes}>
          <td><a href="../drivers/${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(driverRecord.canonicalName)}</a></td>
          ${renderDynamicCompetitionCountCell("starts", stats.starts)}
          ${renderDynamicCompetitionCountCell("wins", stats.wins)}
          ${renderDynamicCompetitionCountCell("finals", placingSummary.finals)}
          ${renderDynamicCompetitionCountCell("podiums", placingSummary.podiums)}
          ${renderDynamicCompetitionCountCell("top-6", placingSummary.top6)}
          ${renderDynamicCompetitionCountCell("top-10", placingSummary.top10)}
          ${renderDynamicCompetitionCountCell("top-25", placingSummary.top25)}
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
      ${renderCompetitionFilterPanel("placings-index", "Include competitions in totals")}
      <table data-sort-table data-competition-stats-table="placings" data-competition-filter-target="placings-index">
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
  const tabs = competitionDefinitions.map((definition) => ({
    suffix: definition.type,
    label: definition.label,
    content: renderCompetitionResultsGraphSection(
      driverRecords,
      getCompetitionEventRecords(eventRecords, definition.type),
      definition.type,
      true,
      "..",
    ),
  }));

  const content = renderLayout(
    "Results Graph",
    `
      <h1>Results Graph</h1>
      ${renderTabPanels("results-graph", tabs, competitionDefinitions[0]?.type ?? "cotd", "Results graph competitions")}
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
  cotdEventRecordsByNumber: Map<number, EventRecord>,
  previousEventRecord: EventRecord | null,
  nextEventRecord: EventRecord | null,
): Promise<void> {
  const hasRouletteColumns = eventRecord.competitionType === "roulette";
  const resultRows = eventRecord.results
    .map((result) => {
      const sourceEventRecord = result.rouletteSourceEventNumber
        ? (cotdEventRecordsByNumber.get(result.rouletteSourceEventNumber) ??
          null)
        : null;
      const sortAttributes = renderSortDataAttributes({
        placing: normalizeNumberSortValue(result.placing),
        driver: normalizeTextSortValue(result.name),
        time: normalizeTimeSortValue(result.time),
        "elimination-round": normalizeTextSortValue(result.eliminationRound),
        "roulette-map": normalizeTextSortValue(result.rouletteMap),
        "roulette-mapper": normalizeTextSortValue(result.rouletteMapper),
        "roulette-source": normalizeNumberSortValue(
          result.rouletteSourceEventNumber,
        ),
      });
      const rouletteMapMarkup = result.rouletteMap
        ? sourceEventRecord
          ? renderEventMapLink(sourceEventRecord, "..", result.rouletteMap)
          : escapeHtml(result.rouletteMap)
        : "-";
      const rouletteSourceMarkup = result.rouletteSourceEventNumber
        ? sourceEventRecord
          ? renderEventLink(
              sourceEventRecord,
              "..",
              String(result.rouletteSourceEventNumber),
            )
          : String(result.rouletteSourceEventNumber)
        : "-";

      return `
        <tr${sortAttributes}>
          <td class="align-right number-cell">${result.placing ?? "-"}</td>
          <td>${renderDriverLink(result.name, driverFileNames, "..")}</td>
          <td class="align-right number-cell">${formatRaceTimeHtml(result.time)}</td>
          <td class="align-right number-cell">${result.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
          ${
            hasRouletteColumns
              ? `<td>${rouletteMapMarkup}</td>
          <td>${result.rouletteMapper ? renderAuthorLinks([result.rouletteMapper], authorFileNames, "..") : "-"}</td>
          <td class="align-right number-cell">${rouletteSourceMarkup}</td>`
              : ""
          }
        </tr>`;
    })
    .join("\n");

  const content = renderLayout(
    `${eventRecord.eventLabel} - ${eventRecord.map}`,
    `
      <div class="event-heading">
        <div class="event-heading-nav" aria-label="Event navigation">
          ${previousEventRecord ? `<a class="event-nav-link" href="${escapeHtml(previousEventRecord.htmlFileName)}" aria-label="Previous event: ${escapeHtml(previousEventRecord.eventLabel)}">&larr;</a>` : ""}
        </div>
        <h1>${escapeHtml(eventRecord.eventLabel)}</h1>
        <div class="event-heading-nav" aria-label="Event navigation">
          ${nextEventRecord ? `<a class="event-nav-link" href="${escapeHtml(nextEventRecord.htmlFileName)}" aria-label="Next event: ${escapeHtml(nextEventRecord.eventLabel)}">&rarr;</a>` : ""}
        </div>
      </div>
      <h2>${escapeHtml(eventRecord.map)}</h2>
      <table>
        <tbody>
          <tr><th>${eventRecord.competitionType === "roulette" ? "Mappers" : "Author"}</th><td>${renderEventAuthors(eventRecord, authorFileNames, "..")}</td></tr>
          ${eventRecord.description ? `<tr><th>${eventRecord.competitionType === "roulette" ? "Pool" : "Description"}</th><td>${escapeHtml(eventRecord.description)}</td></tr>` : ""}
          <tr><th>Fastest Time</th><td>${renderFastestTimeSummary(eventRecord, driverFileNames, "..")}</td></tr>
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
            ${
              hasRouletteColumns
                ? `${renderSortableHeader("Map", "roulette-map", "text", "asc")}
            ${renderSortableHeader("Mapper", "roulette-mapper", "text", "asc")}
            ${renderSortableHeader(eventRecord.rouletteSourceLabel ?? "Source", "roulette-source", "number", "asc", false, "number-cell")}`
                : ""
            }
          </tr>
        </thead>
        <tbody>
          ${resultRows}
        </tbody>
      </table>
    `,
    {
      pageTitle: `${eventRecord.eventLabel} - ${eventRecord.map}`,
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
  driverRatingHistory: Map<string, Map<string, DriverEventRating>>,
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
  driverRatingHistory: Map<string, Map<string, DriverEventRating>>,
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
  return [...driverRecord.results].sort((left, right) =>
    compareEventRecords(left.eventRecord, right.eventRecord),
  );
}

function buildDriverStats(
  driverRecord: DriverRecord,
  driverRatingSummary: Map<string, DriverRatingSummary>,
  competitionTypes = competitionDefinitions.map(
    (definition) => definition.type,
  ),
): DriverStats {
  const selectedCompetitionTypes = new Set(competitionTypes);
  const driverResults = getDriverResultRecords(driverRecord).filter((entry) =>
    selectedCompetitionTypes.has(entry.eventRecord.competitionType),
  );
  const placingCounts = buildPlacingCountsForCompetitions(
    driverRecord,
    competitionTypes,
  );
  const placingSummary = summarizePlacingCounts(placingCounts);
  const ratingSummary =
    driverRatingSummary.get(driverRecord.canonicalName) ??
    getDefaultDriverRatingSummary();
  const starts = driverResults.length;
  const wins = placingCounts[0] ?? 0;
  const podiums = placingSummary.podiums;
  const top6 = placingSummary.top6;
  const top10 = placingSummary.top10;
  const top25 = placingSummary.top25;
  const winRate = calculateRate(wins, starts);
  const podiumRate = calculateRate(podiums, starts);
  const top6Rate = calculateRate(top6, starts);
  const top10Rate = calculateRate(top10, starts);
  const top25Rate = calculateRate(top25, starts);
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
    top6,
    top6Rate,
    top10,
    top10Rate,
    top25,
    top25Rate,
    bestFinish,
    fastestTimes: countDriverFastestTimes(driverRecord, competitionTypes),
    currentElo: ratingSummary.currentElo,
    peakElo: ratingSummary.peakElo,
  };
}

function calculateRate(count: number, total: number): number {
  return total === 0 ? 0 : (count / total) * 100;
}

function countDriverFastestTimes(
  driverRecord: DriverRecord,
  competitionTypes = competitionDefinitions.map(
    (definition) => definition.type,
  ),
): number {
  const selectedCompetitionTypes = new Set(competitionTypes);
  const knownNames = new Set([
    driverRecord.canonicalName,
    ...driverRecord.aliases,
  ]);

  return Array.from(
    new Set(
      driverRecord.results
        .filter(({ eventRecord }) =>
          selectedCompetitionTypes.has(eventRecord.competitionType),
        )
        .filter(({ eventRecord }) =>
          knownNames.has(eventRecord.fastestTimeDriver ?? ""),
        )
        .map(({ eventRecord }) => eventRecord.eventKey),
    ),
  ).length;
}

function getDefaultDriverRatingSummary(): DriverRatingSummary {
  return {
    currentElo: initialElo,
    peakElo: initialElo,
  };
}

function buildAuthorStats(authorRecord: AuthorRecord): AuthorStats {
  const sortedTracks = [...authorRecord.tracks].sort(compareEventRecords);
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
          <tr><th>Starts</th>${renderColspanValueCell(stats.starts)}</tr>
          <tr><th>Wins</th>${renderCountWithPercentageCells(stats.wins, stats.winRate)}</tr>
          <tr><th>Podiums</th>${renderCountWithPercentageCells(stats.podiums, stats.podiumRate)}</tr>
          <tr><th>Top 6s</th>${renderCountWithPercentageCells(stats.top6, stats.top6Rate)}</tr>
          <tr><th>Top 10s</th>${renderCountWithPercentageCells(stats.top10, stats.top10Rate)}</tr>
          <tr><th>Top 25s</th>${renderCountWithPercentageCells(stats.top25, stats.top25Rate)}</tr>
          <tr><th>Best Finish</th>${renderColspanValueCell(stats.bestFinish ?? "-")}</tr>
          <tr><th>Fastest Times</th>${renderColspanValueCell(stats.fastestTimes)}</tr>
          <tr><th>Elo Current</th>${renderColspanValueCell(formatElo(stats.currentElo))}</tr>
          <tr><th>Elo Peak</th>${renderColspanValueCell(formatElo(stats.peakElo))}</tr>
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
          <tr><th>Tracks</th><td class="align-right" style="width: 50%">${stats.tracks}</td></tr>
          <tr><th>Solo Tracks</th><td class="align-right" style="width: 50%">${stats.soloTracks}</td></tr>
          <tr><th>Co-Authored Tracks</th><td class="align-right" style="width: 50%">${stats.coAuthoredTracks}</td></tr>
          <tr><th>First Event</th><td class="align-right" style="width: 50%">${stats.firstEvent ?? "-"}</td></tr>
          <tr><th>Latest Event</th><td class="align-right" style="width: 50%">${stats.latestEvent ?? "-"}</td></tr>
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
  driverRatingHistory: Map<string, Map<string, DriverEventRating>>,
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
      const ratingAtEvent = ratingHistory.get(eventRecord.eventKey) ?? null;
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
        event: normalizeNumberSortValue(eventRecord.sortOrder),
        map: normalizeTextSortValue(eventRecord.map),
        author: normalizeTextSortValue(eventRecord.authors.join(", ")),
        placing: normalizeNumberSortValue(result?.placing),
        time: normalizeTimeSortValue(result?.time),
        "elimination-round": normalizeTextSortValue(result?.eliminationRound),
        elo: normalizeNumberSortValue(ratingAtEvent?.elo),
      });

      return `
        <tr${rowClasses.length > 0 ? ` class="${rowClasses}"` : ""}${sortAttributes}>
          <td>${renderEventLink(eventRecord, "..")}</td>
          <td class="bold">${renderEventMapLink(eventRecord, "..")}</td>
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
    driverRecord.results.map((entry) => [
      entry.eventRecord.eventKey,
      entry.result,
    ]),
  );

  return eventRecords.map((eventRecord) => ({
    eventRecord,
    result: resultsByEvent.get(eventRecord.eventKey) ?? null,
  }));
}

function getDriverResultRecordsForCompetition(
  driverRecord: DriverRecord,
  competitionType: CompetitionType,
): DriverResultRecord[] {
  return getDriverResultRecords(driverRecord).filter(
    (entry) => entry.eventRecord.competitionType === competitionType,
  );
}

function renderCompetitionResultsGraphSection(
  driverRecords: DriverRecord[],
  eventRecords: EventRecord[],
  competitionType: CompetitionType,
  includeSelector: boolean,
  rootPrefix: string,
): string {
  if (eventRecords.length === 0) {
    return '<p class="graph-empty">No graph data available.</p>';
  }

  const sortedDriverRecords = [...driverRecords]
    .filter(
      (driverRecord) =>
        getDriverResultRecordsForCompetition(driverRecord, competitionType)
          .length > 0,
    )
    .sort(
      (left, right) =>
        getDriverWinCount(right, competitionType) -
          getDriverWinCount(left, competitionType) ||
        getDriverResultRecordsForCompetition(right, competitionType).length -
          getDriverResultRecordsForCompetition(left, competitionType).length ||
        left.canonicalName.localeCompare(right.canonicalName),
    );
  const series = sortedDriverRecords.map((driverRecord, index) =>
    buildRaceResultsGraphSeries(
      driverRecord,
      eventRecords,
      graphPalette[index % graphPalette.length] ?? "#0047ab",
      `${rootPrefix}/drivers/${driverRecord.htmlFileName}`,
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
  const graphId = `combined-race-results-${competitionType}`;

  return `
    <p class="graph-note">Only top ${graphMaxPlacing} placings are shown directly; anything below that is grouped into ${graphMaxPlacing}+. Breaks indicate no participation.</p>
    ${includeSelector ? renderRaceResultsGraphSelector(series, defaultVisibleIds, graphId, competitionType) : ""}
    ${renderRaceResultsGraphSvg(initialSeries, eventRecords, false, true, defaultVisibleIds, graphId)}
  `;
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

  return `
    <h2>Results Graph</h2>
    ${renderTabPanels(
      "player-results-graph",
      competitionDefinitions.map((definition) => ({
        suffix: definition.type,
        label: definition.label,
        content: renderPlayerCompetitionGraphSection(
          driverRecord,
          getCompetitionEventRecords(eventRecords, definition.type),
          definition.type,
        ),
      })),
      competitionDefinitions[0]?.type ?? "cotd",
      "Player results graph competitions",
    )}
  `;
}

function renderPlayerCompetitionGraphSection(
  driverRecord: DriverRecord,
  eventRecords: EventRecord[],
  competitionType: CompetitionType,
): string {
  const competitionResults = getDriverResultRecordsForCompetition(
    driverRecord,
    competitionType,
  );

  if (eventRecords.length === 0 || competitionResults.length === 0) {
    return '<p class="graph-empty">No results in this competition.</p>';
  }

  const series = [
    buildRaceResultsGraphSeries(
      driverRecord,
      eventRecords,
      graphPalette[0] ?? "#0047ab",
      null,
    ),
  ];
  const compareHref = `../race-results-graph/index.html?competition=${encodeURIComponent(competitionType)}&compare=${encodeURIComponent(series[0]?.id ?? stableId(driverRecord.canonicalName))}#results-graph-${competitionType}`;

  return `
    <p class="graph-note">Only top ${graphMaxPlacing} placings are shown directly; anything below that is grouped into ${graphMaxPlacing}+. Breaks indicate no participation.</p>
    ${renderRaceResultsGraphSvg(
      series,
      eventRecords,
      false,
      true,
      series.map((entry) => entry.id),
      null,
    )}
    <p class="graph-actions"><a class="graph-compare-link" href="${compareHref}">Compare Results</a></p>
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
  const placingCountsByCompetition = Object.fromEntries(
    competitionDefinitions.map(({ type }) => [
      type,
      buildPlacingCountsForCompetitions(driverRecord, [type]),
    ]),
  ) as Record<CompetitionType, number[]>;
  const rows = placingCounts
    .map((count, index) => {
      const placing = index + 1;
      const competitionAttributes = renderCompetitionMetricAttributes({
        "placing-count": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            placingCountsByCompetition[type][placing - 1] ?? 0,
          ]),
        ),
      });

      return `
        <tr${competitionAttributes}>
          <th class="align-right">${placing}</th>
          ${renderDynamicCompetitionCountCell(
            "placing-count",
            count,
            `placingNo bold${placing >= 1 && placing <= 25 ? ` placing-${placing}` : ""}`,
          )}
        </tr>`;
    })
    .join("\n");

  return `
    <h2>Placings</h2>
    ${renderCompetitionFilterPanel("player-placings", "Include competitions in totals")}
    <table class="compact-table placings-table" data-competition-stats-table="player-placings" data-competition-filter-target="player-placings">
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
  return buildPlacingCountsForCompetitions(
    driverRecord,
    competitionDefinitions.map((definition) => definition.type),
  );
}

function buildPlacingCountsForCompetitions(
  driverRecord: DriverRecord,
  competitionTypes: CompetitionType[],
): number[] {
  const counts = Array.from({ length: 50 }, () => 0);
  const selectedCompetitionTypes = new Set(competitionTypes);

  for (const { eventRecord, result } of getDriverResultRecords(driverRecord)) {
    if (!selectedCompetitionTypes.has(eventRecord.competitionType)) {
      continue;
    }

    if (result.placing === null || result.placing < 1 || result.placing > 50) {
      continue;
    }

    counts[result.placing - 1] += 1;
  }

  return counts;
}

function summarizePlacingCounts(placingCounts: number[]): {
  finals: number;
  podiums: number;
  top6: number;
  top10: number;
  top25: number;
} {
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

  return {
    finals,
    podiums,
    top6,
    top10,
    top25,
  };
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
          ? `${eventRecord.eventLabel}: no placing`
          : `${formatPlacingLabel(result.placing)} - ${eventRecord.eventLabel} ${eventRecord.map}`,
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
  graphTarget: string,
  competitionType: CompetitionType,
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
    <div class="graph-controls" data-graph-picker data-graph-target="${escapeHtml(graphTarget)}" data-competition-type="${escapeHtml(competitionType)}">
      <p class="graph-note">The top ${combinedGraphDefaultSelectionCount} players are enabled by default. Each dropdown includes every player.</p>
      <div class="graph-select-list">
        ${quickPicks}
      </div>
    </div>`;
}

function getDriverWinCount(
  driverRecord: DriverRecord,
  competitionType?: CompetitionType,
): number {
  const resultRecords = competitionType
    ? getDriverResultRecordsForCompetition(driverRecord, competitionType)
    : getDriverResultRecords(driverRecord);

  return resultRecords.filter((entry) => entry.result.placing === 1).length;
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
    .sort(compareEventRecords)
    .map((eventRecord) => {
      const winners = eventRecord.results.filter(
        (result) => result.placing === 1,
      );
      const sortAttributes = renderSortDataAttributes({
        event: normalizeNumberSortValue(eventRecord.sortOrder),
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
          <td>${renderEventLink(eventRecord, "..")}</td>
          <td class="bold">${renderEventMapLink(eventRecord, "..")}</td>
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
  const medals = ["🥇", "🥈", "🥉"];

  return eventRecord.podium
    .map(
      (group) =>
        `${medals[group.placing - 1] || ""} ${renderDriverList(group.entries, driverFileNames, rootPrefix)}`,
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
        const competitionTypes = ${JSON.stringify(
          competitionDefinitions.map((definition) => definition.type),
        )};

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
          const compareParams = new URLSearchParams(window.location.search);
          const compareSeriesId = compareParams.get("compare") || "";
          const compareCompetitionType = compareParams.get("competition") || "";
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

          const hasCompareSeriesId =
            compareSeriesId.length > 0 &&
            (compareCompetitionType.length === 0 ||
              picker.getAttribute("data-competition-type") === compareCompetitionType) &&
            Array.from(optionSets.values()).some((optionSet) =>
              optionSet.some((option) => option.value === compareSeriesId),
            );

          const graphRoot = document.querySelector(
            '[data-graph-root="' + graphTarget + '"]',
          );

          const getUnavailableSeriesIds = (currentSelect) =>
            new Set(
              selects
                .filter((select) => select !== currentSelect)
                .map((select) => select.value)
                .filter((value) => value.length > 0),
            );

          const updateSelectOptions = (select, query) => {
            const optionSet = optionSets.get(select) || [];
            const selectedValue = select.value;
            const normalizedQuery = (query || "").trim().toLowerCase();
            const unavailableSeriesIds = getUnavailableSeriesIds(select);
            const matchingOptions = optionSet.filter((option) => {
              if (option.value === "") {
                return true;
              }

              if (option.value === selectedValue) {
                return true;
              }

              if (unavailableSeriesIds.has(option.value)) {
                return false;
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

          const refreshSelectOptions = () => {
            for (const select of selects) {
              const filterInput = select
                .closest(".graph-select-item")
                ?.querySelector("[data-graph-select-filter]");
              updateSelectOptions(select, filterInput?.value || "");
            }
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

            if (hasCompareSeriesId) {
              select.value = select === selects[0] ? compareSeriesId : "";

              if (filterInput) {
                filterInput.value = "";
              }
            }

            if (filterInput) {
              filterInput.addEventListener("input", () => {
                updateSelectOptions(select, filterInput.value);
              });
            }

            select.addEventListener("change", () => {
              refreshSelectOptions();
              updateGraphSelection();
            });
          }

          refreshSelectOptions();
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

          table.__refreshSort = () => {
            const activeSorter =
              sorters.find((sorter) => sorter.classList.contains("active")) ||
              initialSorter;

            if (!activeSorter) {
              return;
            }

            sortRows(
              activeSorter,
              activeSorter.dataset.sortDirection ||
                activeSorter.dataset.sortDefaultDirection ||
                "asc",
            );
          };

          if (table.__refreshSort) {
            table.__refreshSort();
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

        const formatDecimalParts = (value) => {
          const normalized = String(value);
          const match = normalized.match(/^(.*?)([.,])(\d+)$/);

          if (!match) {
            return null;
          }

          return {
            wholePart: match[1],
            separator: match[2],
            fractionalPart: match[3],
          };
        };

        const formatCompetitionCellHtml = (metricKey, value) => {
          if (metricKey === "win-rate" || metricKey === "podium-rate") {
            if (value === 0) {
              return "";
            }

            const parts = formatDecimalParts(value.toFixed(1));

            if (!parts) {
              return value.toFixed(1) + "<small>%</small>";
            }

            return parts.wholePart + parts.separator + "<small>" + parts.fractionalPart + "</small><small>%</small>";
          }

          return value === 0 ? "" : String(value);
        };

        const sumCompetitionMetric = (row, metricKey, selectedCompetitionTypes) =>
          selectedCompetitionTypes.reduce((sum, competitionType) => {
            const attributeValue = Number(
              row.getAttribute("data-stats-" + competitionType + "-" + metricKey) ||
                "0",
            );

            return sum + attributeValue;
          }, 0);

        const getCompetitionMetricValue = (row, metricKey, selectedCompetitionTypes) => {
          if (metricKey === "win-rate") {
            const starts = sumCompetitionMetric(row, "starts", selectedCompetitionTypes);
            const wins = sumCompetitionMetric(row, "wins", selectedCompetitionTypes);

            return starts > 0 ? (wins / starts) * 100 : 0;
          }

          if (metricKey === "podium-rate") {
            const starts = sumCompetitionMetric(row, "starts", selectedCompetitionTypes);
            const podiums = sumCompetitionMetric(row, "podiums", selectedCompetitionTypes);

            return starts > 0 ? (podiums / starts) * 100 : 0;
          }

          return sumCompetitionMetric(row, metricKey, selectedCompetitionTypes);
        };

        for (const filterGroup of document.querySelectorAll("[data-competition-filter-group]")) {
          const filterTarget =
            filterGroup.getAttribute("data-competition-filter-target") || "";
          const toggles = Array.from(
            filterGroup.querySelectorAll("[data-competition-toggle]"),
          );
          const tables = Array.from(
            document.querySelectorAll(
              '[data-competition-filter-target="' + filterTarget + '"]',
            ),
          ).filter((table) => table !== filterGroup);

          if (!filterTarget || toggles.length === 0 || tables.length === 0) {
            continue;
          }

          const updateCompetitionTotals = () => {
            const selectedCompetitionTypes = competitionTypes.filter((competitionType) =>
              toggles.some(
                (toggle) =>
                  toggle.value === competitionType &&
                  toggle.checked,
              ),
            );

            for (const table of tables) {
              const rows = Array.from(table.querySelectorAll("tbody tr"));

              for (const row of rows) {
                for (const cell of row.querySelectorAll("[data-competition-cell]")) {
                  const metricKey = cell.getAttribute("data-competition-cell") || "";

                  if (!metricKey) {
                    continue;
                  }

                  const metricValue = getCompetitionMetricValue(
                    row,
                    metricKey,
                    selectedCompetitionTypes,
                  );

                  cell.classList.toggle("is-zero", metricValue === 0);
                  cell.innerHTML = formatCompetitionCellHtml(metricKey, metricValue);
                  row.setAttribute("data-sort-" + metricKey, String(metricValue));
                }
              }

              if (typeof table.__refreshSort === "function") {
                table.__refreshSort();
              }
            }
          };

          for (const toggle of toggles) {
            toggle.addEventListener("change", updateCompetitionTotals);
          }

          updateCompetitionTotals();
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

function renderCountWithPercentageCells(
  count: number,
  percentage: number,
): string {
  return `<td class="align-right" style="width: 33%">${count}</td><td class="align-right" style="width: 33%">${formatPercentage(percentage)}</td>`;
}

function renderColspanValueCell(value: number | string): string {
  return `<td class="align-right" colspan="2">${value}</td>`;
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
