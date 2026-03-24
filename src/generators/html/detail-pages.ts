import type { CompetitionType, EventRecord } from "../../lib/event-data";

import { escapeHtml } from "./shell";

type RenderLayout = (
  title: string,
  bodyContent: string,
  options: {
    pageTitle: string;
    rootPrefix: string;
    competitionTypes: CompetitionType[];
  },
) => string;

type ProfileDefaultTab =
  | "placings"
  | "race-results-graph"
  | "tracks"
  | "race-results";

type RenderSortableHeader = (
  label: string,
  key: string,
  type: "text" | "number",
  defaultDirection: "asc" | "desc",
  isActive?: boolean,
  headerClass?: string,
) => string;

type EventStats = {
  participantCount: number;
  dnfCount: number;
  winnersAllTime: number;
  winsAllTime: number;
};

type EventPageOptions = {
  eventRecord: EventRecord;
  eventStats: EventStats;
  resultRowsHtml: string;
  hasRouletteColumns: boolean;
  previousEventRecord: EventRecord | null;
  nextEventRecord: EventRecord | null;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderSortableHeader: RenderSortableHeader;
  renderEventAuthors: (
    eventRecord: EventRecord,
    authorFileNames: Map<string, string>,
    rootPrefix: string,
    compact?: boolean,
  ) => string;
  renderFastestTimeSummary: (
    eventRecord: EventRecord,
    driverFileNames: Map<string, string>,
    rootPrefix: string,
  ) => string;
  renderPodium: (
    eventRecord: EventRecord,
    driverFileNames: Map<string, string>,
    rootPrefix: string,
  ) => string;
  driverFileNames: Map<string, string>;
  authorFileNames: Map<string, string>;
};

export function renderEventPageContent(options: EventPageOptions): string {
  const {
    eventRecord,
    eventStats,
    resultRowsHtml,
    hasRouletteColumns,
    previousEventRecord,
    nextEventRecord,
  } = options;

  return options.renderLayout(
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
          <tr><th>${eventRecord.competitionType === "roulette" ? "Mappers" : "Author"}</th><td>${options.renderEventAuthors(eventRecord, options.authorFileNames, "..")}</td></tr>
          <tr><th>Participants</th><td>${eventStats.participantCount}</td></tr>
          <tr><th>DNFs</th><td>${eventStats.dnfCount}</td></tr>
          <tr><th>Winners (all time)</th><td>${eventStats.winnersAllTime}</td></tr>
          <tr><th>Wins (all time)</th><td>${eventStats.winsAllTime}</td></tr>
          ${eventRecord.description ? `<tr><th>${eventRecord.competitionType === "roulette" ? "Pool" : "Description"}</th><td>${escapeHtml(eventRecord.description)}</td></tr>` : ""}
          <tr><th>Fastest Time</th><td>${options.renderFastestTimeSummary(eventRecord, options.driverFileNames, "..")}</td></tr>
          <tr><th>Podium</th><td>${options.renderPodium(eventRecord, options.driverFileNames, "..")}</td></tr>
        </tbody>
      </table>
      <h2>Results</h2>
      <table data-sort-table>
        <thead>
          <tr>
            ${options.renderSortableHeader("Placing", "placing", "number", "asc", true, "number-cell")}
            ${options.renderSortableHeader("Player", "driver", "text", "asc")}
            ${options.renderSortableHeader("Time", "time", "number", "asc", false, "number-cell")}
            ${options.renderSortableHeader("Elimination Round", "elimination-round", "text", "asc", false, "number-cell")}
            ${
              hasRouletteColumns
                ? `${options.renderSortableHeader("Map", "roulette-map", "text", "asc")}
            ${options.renderSortableHeader("Mapper", "roulette-mapper", "text", "asc")}
            ${options.renderSortableHeader(eventRecord.rouletteSourceLabel ?? "Source", "roulette-source", "number", "asc", false, "number-cell")}`
                : ""
            }
          </tr>
        </thead>
        <tbody>
          ${resultRowsHtml}
        </tbody>
      </table>
    `,
    {
      pageTitle: `${eventRecord.eventLabel} - ${eventRecord.map}`,
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}

type DriverPageOptions<TDriverRecord, TAuthorRecord, TDriverRatingSummary> = {
  driverRecord: TDriverRecord & { canonicalName: string; aliases: string[] };
  matchingAuthorRecord: TAuthorRecord | null;
  driverFileNames: Map<string, string>;
  authorFileNames: Map<string, string>;
  driverRatingSummary: TDriverRatingSummary;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderPlayerProfileHeading: (
    canonicalName: string,
    aliases: string[],
  ) => string;
  renderProfileMetadata: (
    driverRecord: TDriverRecord | null,
    authorRecord: TAuthorRecord | null,
    driverFileNames: Map<string, string>,
    authorFileNames: Map<string, string>,
    rootPrefix: string,
    driverRatingSummary: TDriverRatingSummary,
  ) => string;
  renderProfileTabs: (
    raceResultsMarkup: string,
    graphMarkup: string,
    placingsMarkup: string,
    tracksMarkup: string,
    defaultTab: ProfileDefaultTab,
  ) => string;
  raceResultsMarkup: string;
  graphMarkup: string;
  placingsMarkup: string;
  tracksMarkup: string;
};

export function renderDriverPageContent<
  TDriverRecord,
  TAuthorRecord,
  TDriverRatingSummary,
>(
  options: DriverPageOptions<
    TDriverRecord,
    TAuthorRecord,
    TDriverRatingSummary
  >,
): string {
  return options.renderLayout(
    options.driverRecord.canonicalName,
    `
      ${options.renderPlayerProfileHeading(options.driverRecord.canonicalName, options.driverRecord.aliases)}
      ${options.renderProfileMetadata(
        options.driverRecord,
        options.matchingAuthorRecord,
        options.driverFileNames,
        options.authorFileNames,
        "..",
        options.driverRatingSummary,
      )}
      ${options.renderProfileTabs(
        options.raceResultsMarkup,
        options.graphMarkup,
        options.placingsMarkup,
        options.tracksMarkup,
        "race-results",
      )}
    `,
    {
      pageTitle: options.driverRecord.canonicalName,
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}

type AuthorPageOptions<TAuthorRecord, TDriverRecord, TDriverRatingSummary> = {
  authorRecord: TAuthorRecord & { canonicalName: string; aliases: string[] };
  matchingDriverRecord: TDriverRecord | null;
  driverFileNames: Map<string, string>;
  authorFileNames: Map<string, string>;
  driverRatingSummary: TDriverRatingSummary;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderProfileHeading: (canonicalName: string, aliases: string[]) => string;
  renderProfileMetadata: (
    driverRecord: TDriverRecord | null,
    authorRecord: TAuthorRecord | null,
    driverFileNames: Map<string, string>,
    authorFileNames: Map<string, string>,
    rootPrefix: string,
    driverRatingSummary: TDriverRatingSummary,
  ) => string;
  renderProfileTabs: (
    raceResultsMarkup: string,
    graphMarkup: string,
    placingsMarkup: string,
    tracksMarkup: string,
    defaultTab: ProfileDefaultTab,
  ) => string;
  raceResultsMarkup: string;
  graphMarkup: string;
  placingsMarkup: string;
  tracksMarkup: string;
};

export function renderAuthorPageContent<
  TAuthorRecord,
  TDriverRecord,
  TDriverRatingSummary,
>(
  options: AuthorPageOptions<
    TAuthorRecord,
    TDriverRecord,
    TDriverRatingSummary
  >,
): string {
  return options.renderLayout(
    options.authorRecord.canonicalName,
    `
      ${options.renderProfileHeading(options.authorRecord.canonicalName, options.authorRecord.aliases)}
      ${options.renderProfileMetadata(
        options.matchingDriverRecord,
        options.authorRecord,
        options.driverFileNames,
        options.authorFileNames,
        "..",
        options.driverRatingSummary,
      )}
      ${options.renderProfileTabs(
        options.raceResultsMarkup,
        options.graphMarkup,
        options.placingsMarkup,
        options.tracksMarkup,
        "tracks",
      )}
    `,
    {
      pageTitle: options.authorRecord.canonicalName,
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}
