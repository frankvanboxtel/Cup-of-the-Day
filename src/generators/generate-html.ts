import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  renderAuthorPageContent,
  renderDriverPageContent,
  renderEventPageContent,
} from "./html/detail-pages";
import {
  renderDriverIndexPageContent,
  renderOverviewPageContent,
  renderPlacingsIndexPageContent,
  renderResultsGraphIndexPageContent,
} from "./html/index-pages";
import { escapeHtml, renderLayout } from "./html/shell";
import {
  compareEventRecords,
  competitionDefinitions,
  getCompetitionEventRecords,
  loadEventRecords,
} from "../lib/event-data";
import type {
  CompetitionType,
  EventRecord,
  ResultEntry,
} from "../lib/event-data";
import {
  isDisplayOnlyName,
  loadAliasResolver,
  loadDisplayOnlyNames,
  normalizeWhitespace,
  resolveAlias,
} from "../lib/player-names";
import type { AliasResolver } from "../lib/player-names";
import { bayesConfig, buildEventRatings, initialElo } from "../lib/ratings";
import type {
  DriverEventRating,
  DriverRatingSummary,
  RatingParticipant,
  RatingSnapshot,
} from "../lib/ratings";

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
  finals: number;
  finalsRate: number;
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
  ratings: DriverRatingSummary;
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

const projectRoot = path.resolve(__dirname, "../..");
const resultsDirectory = path.join(projectRoot, "data", "generated-jsons");
const outputDirectory = path.join(projectRoot, "dist");
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
const playerDataDirectory = path.join(projectRoot, "preferences");
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
const graphDirectMaxPlacing = 25;
const graphOverflowBuckets = [25, 30, 40, 50] as const;
const graphOverflowBucketStart = graphDirectMaxPlacing + 1;
const graphOverflowBucketLabels = new Map(
  graphOverflowBuckets.map((threshold, index) => [
    graphOverflowBucketStart + index,
    `${threshold}+`,
  ]),
);
const graphMaxBucketValue =
  graphOverflowBucketStart + graphOverflowBuckets.length - 1;
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
const competitionTypes = competitionDefinitions.map(
  (definition) => definition.type,
);

async function main(): Promise<void> {
  const aliasResolver = await loadAliasResolver(
    manualAliasListPath,
    generatedAliasListPath,
  );
  const displayOnlyNames = await loadDisplayOnlyNames(displayOnlyNameListPath);
  const eventRecords = await loadEventRecords(resultsDirectory);
  const cotdEventRecordsByNumber = new Map(
    getCompetitionEventRecords(eventRecords, "cotd").map((eventRecord) => [
      eventRecord.nr,
      eventRecord,
    ]),
  );
  const ratedEventRecords = eventRecords.filter(
    (eventRecord) => eventRecord.competitionType === "cotd",
  );
  const eventRatings = buildEventRatings(ratedEventRecords, (eventRecord) =>
    buildCanonicalEventResults(eventRecord, aliasResolver, displayOnlyNames),
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
          eventRecords,
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

function formatCompetitionTabLabel(
  label: string,
  participationCount: number,
): string {
  return `${label} (${participationCount})`;
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

function buildCanonicalEventResults(
  eventRecord: EventRecord,
  aliasResolver: AliasResolver,
  displayOnlyNames: Set<string>,
): RatingParticipant[] {
  const byDriver = new Map<string, RatingParticipant>();

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
      });
      continue;
    }

    const currentPlacing = result.placing ?? Number.MAX_SAFE_INTEGER;
    const existingPlacing = existing.placing ?? Number.MAX_SAFE_INTEGER;

    if (currentPlacing < existingPlacing) {
      byDriver.set(canonicalName, {
        canonicalName,
        placing: result.placing,
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

  const content = renderOverviewPageContent({
    eventCount: eventRecords.length,
    competitionCount: competitionDefinitions.length,
    tabs,
    defaultCompetitionType: competitionTypes[0] ?? "cotd",
    competitionTypes,
    renderLayout,
    renderTabPanels,
  });

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

  const competitionWinnerRecords = eventRecords.flatMap((eventRecord) =>
    eventRecord.results.filter((result) => result.placing === 1),
  );
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
      const eventStats = buildCompetitionEventStats(
        eventRecord,
        competitionWinnerRecords,
        driverFileNames,
      );
      const sortAttributes = renderSortDataAttributes({
        event: eventRecord.nr,
        map: normalizeTextSortValue(eventRecord.map),
        author: normalizeTextSortValue(
          eventRecord.competitionType === "roulette"
            ? eventRecord.author
            : eventRecord.authors.join(", "),
        ),
        participants: normalizeNumberSortValue(eventStats.participantCount),
        dnfs: normalizeNumberSortValue(eventStats.dnfCount),
        winners: normalizeNumberSortValue(eventStats.winnersAllTime),
        "wins-all-time": normalizeNumberSortValue(eventStats.winsAllTime),
        "fastest-time": normalizeTimeSortValue(eventRecord.fastestTime),
        "fastest-driver": normalizeTextSortValue(eventRecord.fastestTimeDriver),
      });

      return `
        <tr${sortAttributes}>
          <td class="number-cell">${renderEventLink(eventRecord, rootPrefix)}</td>
          <td class="bold">${renderEventMapLink(eventRecord, rootPrefix)}</td>
          <td>${authors}</td>
          <td class="align-right number-cell">${eventStats.participantCount}</td>
          <td class="align-right number-cell">${eventStats.dnfCount}</td>
          <td class="align-right number-cell">${eventStats.winnersAllTime}</td>
          <td class="align-right number-cell">${eventStats.winsAllTime}</td>
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
          ${renderSortableHeader("Participants", "participants", "number", "desc", false, "number-cell")}
          ${renderSortableHeader("DNFs", "dnfs", "number", "desc", false, "number-cell")}
          ${renderSortableHeader("Winners (all time)", "winners", "number", "desc", false, "number-cell")}
          ${renderSortableHeader("Wins (all time)", "wins-all-time", "number", "desc", false, "number-cell")}
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

function isDnfResultTime(value: string | null | undefined): boolean {
  return /^dnf\*?$/i.test((value ?? "").trim());
}

function buildCompetitionEventStats(
  eventRecord: EventRecord,
  competitionWinnerRecords: ResultEntry[],
  driverFileNames: Map<string, string>,
): {
  participantCount: number;
  dnfCount: number;
  winnersAllTime: number;
  winsAllTime: number;
} {
  const participantCount = eventRecord.results.length;
  const dnfCount = eventRecord.results.filter((result) =>
    isDnfResultTime(result.time),
  ).length;
  const participantKeys = new Set(
    eventRecord.results.map((result) =>
      getDriverAggregateKey(result.name, driverFileNames),
    ),
  );
  const participantWinnerRecords = competitionWinnerRecords.filter((result) =>
    participantKeys.has(getDriverAggregateKey(result.name, driverFileNames)),
  );

  return {
    participantCount,
    dnfCount,
    winnersAllTime: new Set(
      participantWinnerRecords.map((result) =>
        getDriverAggregateKey(result.name, driverFileNames),
      ),
    ).size,
    winsAllTime: participantWinnerRecords.length,
  };
}

function getDriverAggregateKey(
  name: string,
  driverFileNames: Map<string, string>,
): string {
  return driverFileNames.get(name) ?? `name:${normalizeTextSortValue(name)}`;
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
      const nameDetails = splitTaggedPlayerNames(
        driverRecord.canonicalName,
        driverRecord.aliases,
      );
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
      const aliasSummary = renderInlineList(nameDetails.aliases);
      const tagSummary = renderInlineList(nameDetails.tags.map(formatTagLabel));
      const searchTerms = normalizeSearchText(
        [driverRecord.canonicalName, ...driverRecord.aliases].join(" "),
      );
      const sortAttributes = renderSortDataAttributes({
        driver: normalizeTextSortValue(nameDetails.primaryName),
        aliases: normalizeTextSortValue(nameDetails.aliases.join(" ")),
        tags: normalizeTextSortValue(nameDetails.tags.join(" ")),
        tracks: normalizeNumberSortValue(tracksCreated),
        starts: normalizeNumberSortValue(stats.starts),
        "fastest-times": normalizeNumberSortValue(stats.fastestTimes),
        wins: normalizeNumberSortValue(stats.wins),
        "wins-rate": normalizeNumberSortValue(stats.winRate),
        elo: normalizeNumberSortValue(stats.currentElo),
        bayes: normalizeNumberSortValue(stats.ratings.bayes.current),
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
        "fastest-times": Object.fromEntries(
          competitionDefinitions.map(({ type }) => [
            type,
            statsByCompetition[type].fastestTimes,
          ]),
        ),
      });

      return `
        <tr data-driver-row data-driver-search="${escapeHtml(searchTerms)}"${sortAttributes}${competitionAttributes}>
          <td><a href="${escapeHtml(driverRecord.htmlFileName)}">${escapeHtml(nameDetails.primaryName)}</a></td>
          <td title="${escapeHtml(nameDetails.aliases.join(", "))}"><div class="single-line alias">${aliasSummary}</div></td>
          <td title="${escapeHtml(nameDetails.tags.map(formatTagLabel).join(", "))}"><div class="single-line alias">${tagSummary}</div></td>
          ${renderDynamicCompetitionCountCell("tracks", tracksCreated)}
          ${renderDynamicCompetitionCountCell("starts", stats.starts)}
          ${renderDynamicCompetitionCountCell("fastest-times", stats.fastestTimes)}
          ${renderDynamicCompetitionCountCell("wins", stats.wins)}
          <td class="align-right">${formatPercentage(stats.winRate)}</td>
          <td class="align-right">${formatElo(stats.currentElo)}</td>
          <td class="align-right">${formatElo(stats.ratings.bayes.current)}</td>
        </tr>`;
    })
    .join("\n");

  const content = renderDriverIndexPageContent({
    driverCount: driverRecords.length,
    rowsHtml: rows,
    competitionTypes,
    renderLayout,
    renderCompetitionFilterPanel,
    renderSortableHeader,
  });

  await writeFile(driverIndexFilePath, content, "utf8");
}

async function writePlacingsIndexPage(
  driverRecords: DriverRecord[],
  driverRatingSummary: Map<string, DriverRatingSummary>,
): Promise<void> {
  const placingColumns = Array.from({ length: 10 }, (_, index) => index + 1);
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

  const content = renderPlacingsIndexPageContent({
    driverCount: driverRecords.length,
    rowsHtml: rows,
    placingHeadersHtml: placingHeaders,
    competitionTypes,
    renderLayout,
    renderCompetitionFilterPanel,
    renderSortableHeader,
  });

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

  const content = renderResultsGraphIndexPageContent({
    tabs,
    defaultCompetitionType: competitionTypes[0] ?? "cotd",
    competitionTypes,
    renderLayout,
    renderTabPanels,
  });

  await writeFile(raceResultsGraphIndexFilePath, content, "utf8");
}

async function writeEventPage(
  eventRecord: EventRecord,
  allEventRecords: EventRecord[],
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
  cotdEventRecordsByNumber: Map<number, EventRecord>,
  previousEventRecord: EventRecord | null,
  nextEventRecord: EventRecord | null,
): Promise<void> {
  const hasRouletteColumns = eventRecord.competitionType === "roulette";
  const competitionWinnerRecords = getCompetitionEventRecords(
    allEventRecords,
    eventRecord.competitionType,
  ).flatMap((competitionEventRecord) =>
    competitionEventRecord.results.filter((result) => result.placing === 1),
  );
  const eventStats = buildCompetitionEventStats(
    eventRecord,
    competitionWinnerRecords,
    driverFileNames,
  );
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

      const rowClassName = buildResultRowClassName(result.placing);

      return `
        <tr class="${rowClassName}"${sortAttributes}>
          <td class="placings-column align-right number-cell">${result.placing ?? "-"}</td>
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

  const content = renderEventPageContent({
    eventRecord,
    eventStats,
    resultRowsHtml: resultRows,
    hasRouletteColumns,
    previousEventRecord,
    nextEventRecord,
    competitionTypes,
    renderLayout,
    renderSortableHeader,
    renderEventAuthors,
    renderFastestTimeSummary,
    renderPodium,
    driverFileNames,
    authorFileNames,
  });

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

  const content = renderDriverPageContent({
    driverRecord,
    matchingAuthorRecord,
    driverFileNames,
    authorFileNames,
    driverRatingSummary,
    competitionTypes,
    renderLayout,
    renderPlayerProfileHeading,
    renderProfileMetadata,
    renderProfileTabs,
    raceResultsMarkup: renderRaceResultsSection(
      driverRecord,
      eventRecords,
      authorFileNames,
      driverRatingHistory,
    ),
    graphMarkup: renderRaceResultsGraphSection(driverRecord, eventRecords),
    placingsMarkup: renderPlacingsSection(driverRecord),
    tracksMarkup: renderTracksSection(
      matchingAuthorRecord,
      driverFileNames,
      authorFileNames,
    ),
  });

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

  const content = renderAuthorPageContent({
    authorRecord,
    matchingDriverRecord,
    driverFileNames,
    authorFileNames,
    driverRatingSummary,
    competitionTypes,
    renderLayout,
    renderProfileHeading,
    renderProfileMetadata,
    renderProfileTabs,
    raceResultsMarkup: renderRaceResultsSection(
      matchingDriverRecord,
      eventRecords,
      authorFileNames,
      driverRatingHistory,
    ),
    graphMarkup: renderRaceResultsGraphSection(
      matchingDriverRecord,
      eventRecords,
    ),
    placingsMarkup: renderPlacingsSection(matchingDriverRecord),
    tracksMarkup: renderTracksSection(
      authorRecord,
      driverFileNames,
      authorFileNames,
    ),
  });

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
  const finals = placingSummary.finals;
  const podiums = placingSummary.podiums;
  const top6 = placingSummary.top6;
  const top10 = placingSummary.top10;
  const top25 = placingSummary.top25;
  const winRate = calculateRate(wins, starts);
  const finalsRate = calculateRate(finals, starts);
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
    finals,
    finalsRate,
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
    ratings: ratingSummary,
    currentElo: ratingSummary.elo.current,
    peakElo: ratingSummary.elo.peak,
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
    elo: {
      current: initialElo,
      peak: initialElo,
      deviation: null,
      volatility: null,
    },
    bayes: {
      current: initialElo,
      peak: initialElo,
      deviation: bayesConfig.initialDeviation,
      volatility: null,
    },
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

function renderPlayerProfileHeading(
  canonicalName: string,
  aliases: string[],
): string {
  const nameDetails = splitTaggedPlayerNames(canonicalName, aliases);
  const aliasSummary = renderInlineList(nameDetails.aliases);
  const tagSummary = renderInlineList(nameDetails.tags.map(formatTagLabel));

  return `
    <h1 class="name">${escapeHtml(nameDetails.primaryName)}</h1>
    ${aliasSummary === "-" ? "" : `<div class="aliases"><div>AKA:</div><em>${aliasSummary}</em></div>`}
    ${tagSummary === "-" ? "" : `<div class="aliases"><div>Tags:</div><em>${tagSummary}</em></div>`}
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
          <tr><th>Finals</th>${renderCountWithPercentageCells(stats.finals, stats.finalsRate)}</tr>
          <tr><th>Podiums</th>${renderCountWithPercentageCells(stats.podiums, stats.podiumRate)}</tr>
          <tr><th>Top 6s</th>${renderCountWithPercentageCells(stats.top6, stats.top6Rate)}</tr>
          <tr><th>Top 10s</th>${renderCountWithPercentageCells(stats.top10, stats.top10Rate)}</tr>
          <tr><th>Top 25s</th>${renderCountWithPercentageCells(stats.top25, stats.top25Rate)}</tr>
          <tr><th>Best Finish</th>${renderColspanValueCell(stats.bestFinish ?? "-")}</tr>
          <tr><th>Fastest Times</th>${renderColspanValueCell(stats.fastestTimes)}</tr>
          <tr><th>Elo</th>${renderColspanValueCell(renderRatingSnapshotSummary(stats.ratings.elo, "RD"))}</tr>
          <tr><th>Bayesian</th>${renderColspanValueCell(renderRatingSnapshotSummary(stats.ratings.bayes, "Sigma"))}</tr>
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

  return `
    <h2>Race Results</h2>
    ${renderTabPanels(
      "player-race-results",
      competitionDefinitions.map((definition) => ({
        suffix: definition.type,
        label: formatCompetitionTabLabel(
          definition.label,
          getDriverResultRecordsForCompetition(driverRecord, definition.type)
            .length,
        ),
        content: renderPlayerCompetitionRaceResultsSection(
          driverRecord,
          getCompetitionEventRecords(eventRecords, definition.type),
          authorFileNames,
          ratingHistory,
        ),
      })),
      competitionDefinitions[0]?.type ?? "cotd",
      "Player race results competitions",
    )}
  `;
}

function renderPlayerCompetitionRaceResultsSection(
  driverRecord: DriverRecord,
  eventRecords: EventRecord[],
  authorFileNames: Map<string, string>,
  ratingHistory: Map<string, DriverEventRating>,
): string {
  const competitionResults = eventRecords.filter((eventRecord) =>
    driverRecord.results.some(
      (entry) => entry.eventRecord.eventKey === eventRecord.eventKey,
    ),
  );

  if (eventRecords.length === 0 || competitionResults.length === 0) {
    return "<p>No race results in this competition.</p>";
  }

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
        bayes: normalizeNumberSortValue(ratingAtEvent?.bayes),
      });

      return `
        <tr data-player-timeline-row data-player-participated="${result !== null ? "true" : "false"}"${rowClasses.length > 0 ? ` class="${rowClasses}"` : ""}${sortAttributes}>
          <td>${renderEventLink(eventRecord, "..")}</td>
          <td class="bold">${renderEventMapLink(eventRecord, "..")}</td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${result === null ? (isTrackAuthor ? "Track author" : "Did not race") : "Raced"}</td>
          <td class="placings-column align-right number-cell">${result?.placing ?? "-"}</td>
          <td class="align-right number-cell">${result === null ? "-" : formatRaceTimeHtml(result.time)}</td>
          <td class="align-right number-cell">${result?.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
          <td class="align-right number-cell">${ratingAtEvent ? formatElo(ratingAtEvent.elo) : "-"}</td>
          <td class="align-right number-cell">${ratingAtEvent ? formatElo(ratingAtEvent.bayes) : "-"}</td>
        </tr>`;
    })
    .join("\n");

  return `
    <div data-participation-filter-group>
      <p class="race-results-filter">
        <label class="competition-filter-option">
          <input type="checkbox" data-participation-filter-toggle>
          <span>Only show raced events</span>
        </label>
      </p>
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
          ${renderSortableHeader("Bayes", "bayes", "number", "desc", false, "number-cell")}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    </div>
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
    <p class="graph-note">Placings 1 through ${graphDirectMaxPlacing} are shown directly; lower results are grouped into ${graphOverflowBuckets.map((threshold) => `${threshold}+`).join(", ")}. Breaks indicate no participation.</p>
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
        label: formatCompetitionTabLabel(
          definition.label,
          getDriverResultRecordsForCompetition(driverRecord, definition.type)
            .length,
        ),
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
    <p class="graph-note">Placings 1 through ${graphDirectMaxPlacing} are shown directly; lower results are grouped into ${graphOverflowBuckets.map((threshold) => `${threshold}+`).join(", ")}. Breaks indicate no participation.</p>
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
          : mapGraphPlacing(result.placing),
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

function mapGraphPlacing(placing: number): number {
  const normalizedPlacing = Math.max(1, Math.floor(placing));

  if (normalizedPlacing <= graphDirectMaxPlacing) {
    return normalizedPlacing;
  }

  if (normalizedPlacing < 30) {
    return graphOverflowBucketStart;
  }

  if (normalizedPlacing < 40) {
    return graphOverflowBucketStart + 1;
  }

  if (normalizedPlacing < 50) {
    return graphOverflowBucketStart + 2;
  }

  return graphOverflowBucketStart + 3;
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
  const yTicks = [
    ...Array.from({ length: graphDirectMaxPlacing }, (_, index) => index + 1),
    ...Array.from(graphOverflowBucketLabels.keys()),
  ];
  const xTicks = buildGraphEventTicks(firstEvent, lastEvent);
  const xForEvent = (eventNumber: number): number =>
    marginLeft + ((eventNumber - firstEvent) / eventSpan) * plotWidth;
  const yForPlacing = (placing: number): number =>
    marginTop + ((placing - 1) / (graphMaxBucketValue - 1)) * plotHeight;

  const yGrid = yTicks
    .map((placing) => {
      const y = yForPlacing(placing);
      const label = graphOverflowBucketLabels.get(placing) ?? String(placing);

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

function splitTaggedPlayerNames(
  canonicalName: string,
  aliases: string[],
): {
  primaryName: string;
  aliases: string[];
  tags: string[];
} {
  const seenAliases = new Set<string>();
  const seenTags = new Set<string>();
  const aliasNames: string[] = [];
  const tags: string[] = [];
  const knownNames = Array.from(
    new Set(
      [canonicalName, ...aliases].map(normalizeWhitespace).filter(Boolean),
    ),
  );
  const primaryName = stripRedundantCanonicalParenthetical(
    stripLeadingBracketTags(canonicalName),
    stripLeadingBracketTags(canonicalName),
  );

  for (const knownName of knownNames) {
    const { name, tags: extractedTags } = splitLeadingBracketTags(knownName);
    const cleanedName = stripRedundantCanonicalParenthetical(name, primaryName);
    const normalizedName = normalizeTextSortValue(cleanedName);

    if (
      cleanedName &&
      normalizedName !== normalizeTextSortValue(primaryName) &&
      !seenAliases.has(normalizedName)
    ) {
      seenAliases.add(normalizedName);
      aliasNames.push(cleanedName);
    }

    for (const tag of extractedTags) {
      const normalizedTag = normalizeTextSortValue(tag);

      if (!normalizedTag || seenTags.has(normalizedTag)) {
        continue;
      }

      seenTags.add(normalizedTag);
      tags.push(tag);
    }
  }

  return {
    primaryName,
    aliases: aliasNames,
    tags,
  };
}

function stripRedundantCanonicalParenthetical(
  value: string,
  canonicalName: string,
): string {
  const normalizedValue = normalizeWhitespace(value);
  const normalizedCanonicalName = normalizeWhitespace(canonicalName);
  const match = normalizedValue.match(/^(.*?)\s*\(([^)]+)\)$/);

  if (!match) {
    return normalizedValue;
  }

  const baseName = normalizeWhitespace(match[1] ?? "");
  const parentheticalName = normalizeWhitespace(match[2] ?? "");

  if (
    baseName &&
    normalizeTextSortValue(parentheticalName) ===
      normalizeTextSortValue(normalizedCanonicalName)
  ) {
    return baseName;
  }

  return normalizedValue;
}

function stripLeadingBracketTags(value: string): string {
  return splitLeadingBracketTags(value).name;
}

function splitLeadingBracketTags(value: string): {
  name: string;
  tags: string[];
} {
  const normalized = normalizeWhitespace(value);
  const tags: string[] = [];
  let remainder = normalized;

  while (true) {
    const match = remainder.match(/^\[([^\]]+)\]\s*/);

    if (!match) {
      break;
    }

    const tag = normalizeWhitespace(match[1] ?? "");

    if (tag) {
      tags.push(tag);
    }

    remainder = remainder.slice(match[0].length);
  }

  return {
    name: remainder || normalized,
    tags,
  };
}

function formatTagLabel(tag: string): string {
  return `[${tag}]`;
}

function renderInlineList(values: string[]): string {
  if (values.length === 0) {
    return "-";
  }

  return values.map((value) => escapeHtml(value)).join(", ");
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

function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function formatPercentage(value: number): string {
  return `${formatDecimalHtml(value.toFixed(1))}<small>%</small>`;
}

function formatRatingDetail(value: number, digits: number): string {
  return digits === 0 ? Math.round(value).toString() : value.toFixed(digits);
}

function renderRatingSnapshotSummary(
  snapshot: RatingSnapshot,
  deviationLabel: string,
): string {
  const parts = [
    `Current ${formatElo(snapshot.current)}`,
    `Peak ${formatElo(snapshot.peak)}`,
  ];

  if (snapshot.deviation !== null) {
    parts.push(
      `${deviationLabel} ${formatRatingDetail(snapshot.deviation, 1)}`,
    );
  }

  if (snapshot.volatility !== null) {
    parts.push(`Vol ${formatRatingDetail(snapshot.volatility, 3)}`);
  }

  return escapeHtml(parts.join(" / "));
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
