import type { CompetitionType } from "../../lib/event-data";

type LatestResultsUpdate = {
  relativeLabel: string;
  eventLabel: string;
  mapLabel: string;
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderTableContainer(content: string): string {
  return `<div class="table-container">${content}</div>`;
}

export function renderLayout(
  _title: string,
  bodyContent: string,
  options: {
    pageTitle: string;
    rootPrefix: string;
    competitionTypes: CompetitionType[];
    latestResultsUpdate?: LatestResultsUpdate | null;
  },
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
        const competitionTypes = ${JSON.stringify(options.competitionTypes)};
        const themeStorageKey = "cup-of-the-day-theme";
        const themeModes = ["light", "dark"];

        const getStoredTheme = () => {
          try {
            const storedTheme = window.localStorage.getItem(themeStorageKey);
            return themeModes.includes(storedTheme) ? storedTheme : themeModes[0];
          } catch {
            return themeModes[0];
          }
        };

        const applyTheme = (theme) => {
          if (!document.body) {
            return;
          }

          document.body.classList.remove("light-mode", "dark-mode");
          document.body.classList.add(theme + "-mode");
          document.body.setAttribute("data-theme", theme);
        };

        const syncThemeToggle = (theme) => {
          const themeToggle = document.querySelector("[data-theme-toggle]");
          if (themeToggle instanceof HTMLButtonElement) {
            const isDarkMode = theme === "dark";
            themeToggle.setAttribute("aria-pressed", String(isDarkMode));
            themeToggle.textContent = isDarkMode ? "☀️" : "🌙";
            themeToggle.setAttribute(
              "aria-label",
              isDarkMode ? "Switch to light mode" : "Switch to dark mode",
            );
          }
        };

        const persistTheme = (theme) => {
          applyTheme(theme);
          syncThemeToggle(theme);

          try {
            window.localStorage.setItem(themeStorageKey, theme);
          } catch {
            // Ignore storage failures and keep the in-memory theme applied.
          }
        };

        const initialTheme = getStoredTheme();
        applyTheme(initialTheme);
        syncThemeToggle(initialTheme);

        const themeToggle = document.querySelector("[data-theme-toggle]");
        if (themeToggle instanceof HTMLButtonElement) {
          themeToggle.addEventListener("click", () => {
            const nextTheme = document.body.classList.contains("dark-mode")
              ? "light"
              : "dark";
            persistTheme(nextTheme);
          });
        }

        const navMain = document.querySelector(".nav-main");
        if (navMain instanceof HTMLElement) {
          const currentPath = window.location.pathname.replace(/\\/+$/, "");

          for (const navLink of navMain.querySelectorAll("a[href]")) {
            const linkPath = new URL(navLink.href, window.location.href).pathname
              .replace(/\\/+$/, "");
            const isActive = linkPath === currentPath;

            navLink.classList.toggle("active", isActive);
            if (isActive) {
              navLink.setAttribute("aria-current", "page");
            } else {
              navLink.removeAttribute("aria-current");
            }
          }
        }

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

        for (const filterGroup of document.querySelectorAll("[data-participation-filter-group]")) {
          const toggle = filterGroup.querySelector("[data-participation-filter-toggle]");
          const rows = Array.from(
            filterGroup.querySelectorAll("[data-player-timeline-row]"),
          );

          if (!(toggle instanceof HTMLInputElement) || rows.length === 0) {
            continue;
          }

          const updateParticipationFilter = () => {
            for (const row of rows) {
              const participated =
                row.getAttribute("data-player-participated") === "true";
              row.hidden = toggle.checked && !participated;
            }
          };

          toggle.addEventListener("change", updateParticipationFilter);
          updateParticipationFilter();
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
    <script>
      (() => {
        const themeStorageKey = "cup-of-the-day-theme";
        const fallbackTheme = "light";

        let theme = fallbackTheme;

        try {
          const storedTheme = window.localStorage.getItem(themeStorageKey);
          if (storedTheme === "light" || storedTheme === "dark") {
            theme = storedTheme;
          }
        } catch {
          theme = fallbackTheme;
        }

        document.body.classList.add(theme + "-mode");
        document.body.setAttribute("data-theme", theme);
      })();
    </script>
    <nav class="nav nav-main">
      <a href="${options.rootPrefix}/index.html">Overview</a>
      <a href="${options.rootPrefix}/drivers/index.html">Players</a>
      <a href="${options.rootPrefix}/placings/index.html">Placings</a>
      <a href="${options.rootPrefix}/race-results-graph/index.html">Results Graph</a>
      ${
        options.latestResultsUpdate
          ? `<span class="nav-update">Updated: ${escapeHtml(options.latestResultsUpdate.relativeLabel)} (${escapeHtml(options.latestResultsUpdate.eventLabel)}, ${escapeHtml(options.latestResultsUpdate.mapLabel)})</span>`
          : ""
      }
      <button
        type="button"
        data-theme-toggle
        aria-pressed="false"
        aria-label="Switch to dark mode"
      >
        ☀️
      </button>
    </nav>
    ${bodyContent}
  </body>
</html>
`;
}
