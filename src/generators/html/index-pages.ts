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

type RankingsExplainedPageOptions = {
  renderLayout: RenderLayout;
  competitionTypes: CompetitionType[];
};

export function renderRankingsExplainedPageContent(
  options: RankingsExplainedPageOptions,
): string {
  return options.renderLayout(
    "Rankings Explained",
    `
      <h1>Rankings Explained</h1>
      <p>The site shows four player metrics. Elo and Bayes rate results by placing. Pace Index and Pace Form focus on normalized event pace.</p>
      <section>
        <h2>Elo</h2>
        <p>Elo treats each event as a multiplayer placement result. It is the simplest long-term ranking and is easy to compare across players.</p>
      </section>
      <section>
        <h2>Bayes</h2>
        <p>Bayes also rates event placings, but keeps track of uncertainty. Strong results with a small sample are treated more cautiously than the same results over a long span.</p>
      </section>
      <section>
        <h2>Pace</h2>
        <h3>Pace Index</h3>
        <p>Pace Index estimates long-run event pace on a 0 to 100 scale. It normalizes times per event, corrects knockout-time inconsistencies, blends in placing when time information is weak, and softens extreme lows with lower-tail winsorization.</p>
        <h3>Pace Form</h3>
        <p>Pace Form measures recent pace using up to the latest 10 scored events. Players with fewer than 10 recent results are pulled back toward their Pace Index so the form score stays readable and less noisy.</p>
        <h3>How Pace Scores Work</h3>
        <p>Knockout events only record a player&apos;s final time, so later-advancing players can sometimes show a slower recorded time than earlier eliminations. The pace model fixes that by enforcing monotonic adjusted times by placing before scoring the event.</p>
        <p>Non-DNF runs are scored from normalized pace, anchored so top finishers land near 100 and median finishers around 50. Late-round DNFs can still inherit a pace-based score from the field behind them, while true no-time failures fall back to a bounded placing-based score so one unlucky event does not dominate a season.</p>
        <h2>How To Read Them</h2>
        <p>Use Elo and Bayes to read overall competitive strength. Use Pace Index to compare sustained speed quality. Use Pace Form to see who is currently running hot.</p>
      </section>
    `,
    {
      pageTitle: "Rankings Explained",
      rootPrefix: "..",
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
      <p>${options.driverCount} player profiles. Search by player name, alias, or tag.</p>
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
            ${options.renderSortableHeader("Player", "driver", "text", "asc", true)}
            ${options.renderSortableHeader("Aliases", "aliases", "text", "asc")}
            ${options.renderSortableHeader("Tags", "tags", "text", "asc")}
            ${options.renderSortableHeader("Tracks", "tracks", "number", "desc")}
            ${options.renderSortableHeader("Starts", "starts", "number", "desc")}
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

type RankingsIndexPageOptions = {
  driverCount: number;
  rowsHtml: string;
  competitionTypes: CompetitionType[];
  renderLayout: RenderLayout;
  renderCompetitionFilterPanel: RenderCompetitionFilterPanel;
  renderSortableHeader: RenderSortableHeader;
};

export function renderRankingsIndexPageContent(
  options: RankingsIndexPageOptions,
): string {
  return options.renderLayout(
    "Rankings",
    `
      <h1>Rankings</h1>
      <p>${options.driverCount} player rankings. Search by player name, alias, or tag.</p>
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
      ${options.renderCompetitionFilterPanel("rankings-index", "Include competitions in totals")}
      ${renderTableContainer(`
      <table data-sort-table data-competition-stats-table="rankings" data-competition-filter-target="rankings-index">
        <thead>
          <tr>
            ${options.renderSortableHeader("Player", "driver", "text", "asc")}
            ${options.renderSortableHeader("Starts", "starts", "number", "desc")}
            ${options.renderSortableHeader("Fastest Times", "fastest-times", "number", "desc")}
            ${options.renderSortableHeader("Wins", "wins", "number", "desc", true, "align-right")}
            ${options.renderSortableHeader("Win %", "wins-rate", "number", "desc")}
            ${options.renderSortableHeader("Elo", "elo", "number", "desc")}
            ${options.renderSortableHeader("Bayes", "bayes", "number", "desc")}
            ${options.renderSortableHeader("Pace Index", "pace", "number", "desc")}
            ${options.renderSortableHeader("Pace Form", "pace-form", "number", "desc")}
            ${options.renderSortableHeader("Elo Peak", "elo-peak", "number", "desc")}
            ${options.renderSortableHeader("Bayes Peak", "bayes-peak", "number", "desc")}
            ${options.renderSortableHeader("Pace Index Peak", "pace-peak", "number", "desc")}
            ${options.renderSortableHeader("Pace Form Peak", "pace-form-peak", "number", "desc")}
          </tr>
        </thead>
        <tbody>
          ${options.rowsHtml}
        </tbody>
      </table>
      `)}
    `,
    {
      pageTitle: "Rankings",
      rootPrefix: "..",
      competitionTypes: options.competitionTypes,
    },
  );
}

type PlacingsIndexPageOptions = {
  driverCount: number;
  rowsHtml: string;
  placingHeadersHtml: string;
  authorFilterOptionsHtml: string;
  authorFilterResultsJson: string;
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
      <div class="search-panel">
        <label class="search-label" for="placings-author-filter">Filter by author</label>
        <select
          id="placings-author-filter"
          class="search-input"
          data-author-filter-select
          data-author-filter-target="placings-index"
        >
          <option value="">All</option>
          ${options.authorFilterOptionsHtml}
        </select>
      </div>
      <script type="application/json" data-author-filter-results data-author-filter-target="placings-index">${options.authorFilterResultsJson}</script>
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
