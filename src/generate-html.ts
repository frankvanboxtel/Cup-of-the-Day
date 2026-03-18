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

type EventRecord = CupResultFile & {
  jsonFileName: string;
  htmlFileName: string;
  podium: Array<{ placing: number; entries: ResultEntry[] }>;
  authors: string[];
};

type DriverRecord = {
  name: string;
  htmlFileName: string;
  results: EventRecord[];
};

type AuthorRecord = {
  name: string;
  htmlFileName: string;
  tracks: EventRecord[];
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "results");
const outputDirectory = path.join(projectRoot, "html");
const eventsDirectory = path.join(outputDirectory, "events");
const driversDirectory = path.join(outputDirectory, "drivers");
const authorsDirectory = path.join(outputDirectory, "authors");

async function main(): Promise<void> {
  const eventRecords = await loadEventRecords();
  const driverRecords = buildDriverRecords(eventRecords);
  const authorRecords = buildAuthorRecords(eventRecords);

  await rm(outputDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(outputDirectory, { recursive: true }),
    mkdir(eventsDirectory, { recursive: true }),
    mkdir(driversDirectory, { recursive: true }),
    mkdir(authorsDirectory, { recursive: true }),
  ]);

  const driverFileNames = new Map(
    driverRecords.map((record) => [record.name, record.htmlFileName]),
  );
  const authorFileNames = new Map(
    authorRecords.map((record) => [record.name, record.htmlFileName]),
  );

  await Promise.all([
    writeIndexPage(eventRecords, driverFileNames, authorFileNames),
    ...eventRecords.map((eventRecord) =>
      writeEventPage(eventRecord, driverFileNames, authorFileNames),
    ),
    ...driverRecords.map((driverRecord) =>
      writeDriverPage(driverRecord, authorFileNames),
    ),
    ...authorRecords.map((authorRecord) =>
      writeAuthorPage(authorRecord, driverFileNames, authorFileNames),
    ),
  ]);

  console.log(
    `Generated HTML pages in ${path.relative(projectRoot, outputDirectory)} for ${eventRecords.length} events, ${driverRecords.length} drivers, and ${authorRecords.length} authors.`,
  );
}

async function loadEventRecords(): Promise<EventRecord[]> {
  const fileNames = (await readdir(resultsDirectory))
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  const records = await Promise.all(
    fileNames.map(async (fileName) => {
      const filePath = path.join(resultsDirectory, fileName);
      const fileContent = await readFile(filePath, "utf8");
      const parsed = JSON.parse(fileContent) as CupResultFile;
      const authors = splitAuthors(parsed.author);

      return {
        ...parsed,
        jsonFileName: fileName,
        htmlFileName: `${path.basename(fileName, ".json")}.html`,
        podium: buildPodium(parsed.results),
        authors,
      } satisfies EventRecord;
    }),
  );

  return records.sort((left, right) => left.nr - right.nr);
}

function buildDriverRecords(eventRecords: EventRecord[]): DriverRecord[] {
  const driverNames = new Set<string>();

  for (const eventRecord of eventRecords) {
    for (const result of eventRecord.results) {
      driverNames.add(result.name);
    }
  }

  const driverFileNames = new Map(
    Array.from(driverNames)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, `${slugify(name)}-${stableId(name)}.html`]),
  );

  return Array.from(driverNames)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      htmlFileName: driverFileNames.get(name) ?? `${slugify(name)}.html`,
      results: eventRecords.filter((eventRecord) =>
        eventRecord.results.some((result) => result.name === name),
      ),
    }));
}

function buildAuthorRecords(eventRecords: EventRecord[]): AuthorRecord[] {
  const authorNames = new Set<string>();

  for (const eventRecord of eventRecords) {
    for (const author of eventRecord.authors) {
      authorNames.add(author);
    }
  }

  const authorFileNames = new Map(
    Array.from(authorNames)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, `${slugify(name)}-${stableId(name)}.html`]),
  );

  return Array.from(authorNames)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      htmlFileName: authorFileNames.get(name) ?? `${slugify(name)}.html`,
      tracks: eventRecords.filter((eventRecord) =>
        eventRecord.authors.includes(name),
      ),
    }));
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

  await writeFile(path.join(outputDirectory, "index.html"), content, "utf8");
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
  authorFileNames: Map<string, string>,
): Promise<void> {
  const driverResults = driverRecord.results
    .flatMap((eventRecord) =>
      eventRecord.results
        .filter((result) => result.name === driverRecord.name)
        .map((result) => ({ eventRecord, result })),
    )
    .sort((left, right) => left.eventRecord.nr - right.eventRecord.nr);

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

  const rows = driverResults
    .map(
      ({ eventRecord, result }) => `
        <tr>
          <td><a href="../events/${eventRecord.htmlFileName}">COTD ${eventRecord.nr}</a></td>
          <td><a href="../events/${eventRecord.htmlFileName}">${escapeHtml(eventRecord.map)}</a></td>
          <td>${renderAuthorLinks(eventRecord.authors, authorFileNames, "..")}</td>
          <td>${result.placing ?? "-"}</td>
          <td>${escapeHtml(result.time)}</td>
          <td>${result.eliminationRound ? escapeHtml(result.eliminationRound) : "-"}</td>
        </tr>`,
    )
    .join("\n");

  const content = renderLayout(
    driverRecord.name,
    `
      <h1>${escapeHtml(driverRecord.name)}</h1>
      <table>
        <tbody>
          <tr><th>Starts</th><td>${driverResults.length}</td></tr>
          <tr><th>Wins</th><td>${wins}</td></tr>
          <tr><th>Podiums</th><td>${podiums}</td></tr>
          <tr><th>Best Finish</th><td>${bestFinish ?? "-"}</td></tr>
        </tbody>
      </table>
      <h2>Results</h2>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Map</th>
            <th>Author</th>
            <th>Placing</th>
            <th>Time</th>
            <th>Elimination Round</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `,
    {
      pageTitle: driverRecord.name,
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
  driverFileNames: Map<string, string>,
  authorFileNames: Map<string, string>,
): Promise<void> {
  const rows = authorRecord.tracks
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

  const content = renderLayout(
    authorRecord.name,
    `
      <h1>${escapeHtml(authorRecord.name)}</h1>
      <table>
        <tbody>
          <tr><th>Tracks</th><td>${authorRecord.tracks.length}</td></tr>
        </tbody>
      </table>
      <h2>Created Tracks</h2>
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
    `,
    {
      pageTitle: authorRecord.name,
      rootPrefix: "..",
    },
  );

  await writeFile(
    path.join(authorsDirectory, authorRecord.htmlFileName),
    content,
    "utf8",
  );
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
    <style>
      body {
        font-family: sans-serif;
        line-height: 1.4;
        margin: 24px;
      }

      nav {
        margin-bottom: 16px;
      }

      table {
        border-collapse: collapse;
        width: 100%;
        margin-bottom: 24px;
      }

      th,
      td {
        border: 1px solid #999;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }

      th {
        background: #f3f3f3;
      }

      a {
        color: #0047ab;
      }
    </style>
  </head>
  <body>
    <nav>
      <a href="${options.rootPrefix}/index.html">Overview</a>
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
