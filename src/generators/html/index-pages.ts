import type { CompetitionType } from "../../lib/event-data";

import { renderTableContainer } from "./shell";

type TabDefinition = {
  suffix: string;
  label: string;
  content: string;
};

type RenderLayout = (
  title: string,
  bodyContent: string,
  options: {
    pageTitle: string;
    rootPrefix: string;
    competitionTypes: CompetitionType[];
  },
) => string;

type RenderTabPanels = (
  tabPrefix: string,
  tabs: TabDefinition[],
  defaultSuffix: string,
  ariaLabel: string,
) => string;

type RenderCompetitionFilterPanel = (
  filterTarget: string,
  legend: string,
) => string;

type RenderSortableHeader = (
  label: string,
  key: string,
  type: "text" | "number",
  defaultDirection: "asc" | "desc",
  isActive?: boolean,
  headerClass?: string,
) => string;

type IndexPageOptions = {
  eventCount: number;
  competitionCount: number;
  tabs: TabDefinition[];
  defaultCompetitionType: CompetitionType;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderTabPanels: RenderTabPanels;
};

export function renderOverviewPageContent(options: IndexPageOptions): string {
  return options.renderLayout(
    "Cup of the Day",
    `
      <h1>Cup Competitions</h1>
      <p>${options.eventCount} events across ${options.competitionCount} competitions.</p>
      ${options.renderTabPanels("overview", options.tabs, options.defaultCompetitionType, "Overview competitions")}
    `,
    {
      pageTitle: "Cup of the Day Overview",
      rootPrefix: ".",
      competitionTypes: options.competitionTypes,
    },
  );
}

type DriverIndexPageOptions = {
  driverCount: number;
  rowsHtml: string;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderCompetitionFilterPanel: RenderCompetitionFilterPanel;
  renderSortableHeader: RenderSortableHeader;
};

export function renderDriverIndexPageContent(
  options: DriverIndexPageOptions,
): string {
  return options.renderLayout(
    "Players",
    `
      <h1>Players</h1>
      <p>${options.driverCount} player profiles. Search by player name, alias, or tag. Ratings include Elo plus a Bayesian skill estimate.</p>
      <div class="search-panel">
        <label class="search-label" for="driver-search">Search players</label>
        <input
          id="driver-search"
          class="search-input"
          type="search"
          placeholder="Type a player name, alias, or tag"
          autocomplete="off"
          data-driver-search-input
        >
        <p class="search-summary" data-driver-search-summary>${options.driverCount} players shown</p>
      </div>
      ${options.renderCompetitionFilterPanel("players-index", "Include competitions in totals")}
      ${renderTableContainer(`
      <table data-sort-table data-competition-stats-table="players" data-competition-filter-target="players-index">
        <thead>
          <tr>
            ${options.renderSortableHeader("Player", "driver", "text", "asc")}
            ${options.renderSortableHeader("Aliases", "aliases", "text", "asc")}
            ${options.renderSortableHeader("Tags", "tags", "text", "asc")}
            ${options.renderSortableHeader("Tracks", "tracks", "number", "desc")}
            ${options.renderSortableHeader("Starts", "starts", "number", "desc")}
            ${options.renderSortableHeader("Fastest Times", "fastest-times", "number", "desc")}
            ${options.renderSortableHeader("Wins", "wins", "number", "desc", true, "align-right")}
            ${options.renderSortableHeader("Win %", "wins-rate", "number", "desc")}
            ${options.renderSortableHeader("Elo", "elo", "number", "desc")}
            ${options.renderSortableHeader("Bayes", "bayes", "number", "desc")}
          </tr>
        </thead>
        <tbody>
          ${options.rowsHtml}
        </tbody>
      </table>
      `)}
    `,
    {
      pageTitle: "Players",
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}

type PlacingsIndexPageOptions = {
  driverCount: number;
  rowsHtml: string;
  placingHeadersHtml: string;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderCompetitionFilterPanel: RenderCompetitionFilterPanel;
  renderSortableHeader: RenderSortableHeader;
};

export function renderPlacingsIndexPageContent(
  options: PlacingsIndexPageOptions,
): string {
  return options.renderLayout(
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
        <p class="search-summary" data-driver-search-summary>${options.driverCount} players shown</p>
      </div>
      ${options.renderCompetitionFilterPanel("placings-index", "Include competitions in totals")}
      ${renderTableContainer(`
      <table data-sort-table data-competition-stats-table="placings" data-competition-filter-target="placings-index">
        <thead>
          <tr>
            ${options.renderSortableHeader("Player", "driver", "text", "asc")}
            ${options.renderSortableHeader("Starts", "starts", "number", "desc")}
            ${options.renderSortableHeader("Wins", "wins", "number", "desc", true, "align-right")}
            ${options.renderSortableHeader("Finals", "finals", "number", "desc")}
            ${options.renderSortableHeader("Podiums", "podiums", "number", "desc")}
            ${options.renderSortableHeader("Top 6s", "top-6", "number", "desc")}
            ${options.renderSortableHeader("Top 10s", "top-10", "number", "desc")}
            ${options.renderSortableHeader("Top 25s", "top-25", "number", "desc")}
            ${options.placingHeadersHtml}
          </tr>
        </thead>
        <tbody>
          ${options.rowsHtml}
        </tbody>
      </table>
      `)}
    `,
    {
      pageTitle: "Placings",
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}

type ResultsGraphPageOptions = {
  tabs: TabDefinition[];
  defaultCompetitionType: CompetitionType;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderTabPanels: RenderTabPanels;
};

export function renderResultsGraphIndexPageContent(
  options: ResultsGraphPageOptions,
): string {
  return options.renderLayout(
    "Results Graph",
    `
      <h1>Results Graph</h1>
      ${options.renderTabPanels("results-graph", options.tabs, options.defaultCompetitionType, "Results graph competitions")}
    `,
    {
      pageTitle: "Results Graph",
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}
