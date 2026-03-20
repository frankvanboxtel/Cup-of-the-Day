import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "csv-parse/sync";

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

type CupBlock = {
  nr: number;
  headerRowIndex: number;
  placingColumnIndex: number;
};

const projectRoot = path.resolve(__dirname, "..");
const dataDirectory = path.join(projectRoot, "data");
const outputDirectory = path.join(projectRoot, "results");

async function main(): Promise<void> {
  const dataFiles = await readdir(dataDirectory);
  const csvFiles = dataFiles
    .filter((fileName) => fileName.toLowerCase().endsWith(".csv"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  await mkdir(outputDirectory, { recursive: true });
  const existingOutputFiles = await readdir(outputDirectory);

  await Promise.all(
    existingOutputFiles
      .filter(
        (fileName) =>
          fileName.toLowerCase().endsWith(".json") &&
          /^\d+-.*\.json$/i.test(fileName),
      )
      .map((fileName) =>
        rm(path.join(outputDirectory, fileName), { force: true }),
      ),
  );

  let generatedFileCount = 0;

  for (const csvFileName of csvFiles) {
    const sourcePath = path.join(dataDirectory, csvFileName);
    const csvContent = await readFile(sourcePath, "utf8");
    const rows = parse(csvContent, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
      trim: false,
    }) as string[][];

    for (const cupBlock of detectCupBlocks(rows)) {
      const cupData = extractCup(rows, cupBlock, csvFileName);

      const fileName = `${cupData.nr}-${slugify(cupData.map)}-${slugify(cupData.author)}.json`;
      const outputPath = path.join(outputDirectory, fileName);

      await writeFile(
        outputPath,
        `${JSON.stringify(cupData, null, 2)}\n`,
        "utf8",
      );
      generatedFileCount += 1;
    }
  }

  console.log(
    `Generated ${generatedFileCount} cup result files in ${path.relative(projectRoot, outputDirectory)}.`,
  );
}

function detectCupBlocks(rows: string[][]): CupBlock[] {
  const cupBlocks: CupBlock[] = [];
  const seenCupNumbers = new Set<number>();

  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const normalizedValue = value.trim();

      if (!/^COT[DW]\s+\d+\b/i.test(normalizedValue)) {
        continue;
      }

      const nr = parseCupNumber(normalizedValue);

      if (seenCupNumbers.has(nr)) {
        continue;
      }

      seenCupNumbers.add(nr);
      cupBlocks.push({
        nr,
        headerRowIndex: rowIndex,
        placingColumnIndex: columnIndex,
      });
    }
  }

  return cupBlocks.sort((left, right) => left.nr - right.nr);
}

function extractCup(
  rows: string[][],
  cupBlock: CupBlock,
  sourceFileName: string,
): CupResultFile {
  const indexes = {
    placing: cupBlock.placingColumnIndex,
    name: cupBlock.placingColumnIndex + 1,
    time: cupBlock.placingColumnIndex + 2,
    eliminationRound: cupBlock.placingColumnIndex + 3,
  };
  const mapMetadata = parseMapMetadata(
    findMapCell(rows, cupBlock.headerRowIndex, indexes.placing),
  );
  const fastestMetadata = parseFastestMetadata(
    findFastestCell(rows, cupBlock.headerRowIndex, indexes.time),
  );
  const results = extractResults(
    rows,
    indexes,
    findResultsStartRowIndex(rows, cupBlock.headerRowIndex, indexes.placing),
  );

  return {
    nr: cupBlock.nr,
    map: mapMetadata.map,
    author: mapMetadata.author,
    fastestTime: fastestMetadata.time,
    fastestTimeDriver: fastestMetadata.driver,
    fastestTimeRound: fastestMetadata.round,
    sourceFile: sourceFileName,
    results,
  };
}

function extractResults(
  rows: string[][],
  indexes: {
    placing: number;
    name: number;
    time: number;
    eliminationRound: number;
  },
  startRowIndex: number,
): ResultEntry[] {
  const results: ResultEntry[] = [];
  let currentPlacing: number | null = null;

  for (let rowIndex = startRowIndex; rowIndex < rows.length; rowIndex += 1) {
    const name = getCell(rows, rowIndex, indexes.name)?.trim() ?? "";
    const placingValue = getCell(rows, rowIndex, indexes.placing)?.trim() ?? "";
    const time = getCell(rows, rowIndex, indexes.time)?.trim() ?? "";
    const eliminationRound =
      getCell(rows, rowIndex, indexes.eliminationRound)?.trim() ?? "";

    if (!name && !placingValue && !time && !eliminationRound) {
      continue;
    }

    if (!name) {
      continue;
    }

    if (isCommentResultName(name)) {
      continue;
    }

    const parsedPlacing = parseOptionalNumber(placingValue);

    if (parsedPlacing !== null) {
      currentPlacing = parsedPlacing;
    }

    const normalizedPlacing = parsedPlacing ?? currentPlacing;
    const normalizedEliminationRound =
      normalizedPlacing === 1 ? null : eliminationRound || null;

    results.push({
      placing: normalizedPlacing,
      name,
      time,
      eliminationRound: normalizedEliminationRound,
    });
  }

  return results;
}

function findMapCell(
  rows: string[][],
  headerRowIndex: number,
  placingColumnIndex: number,
): string | undefined {
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex <= Math.min(rows.length - 1, headerRowIndex + 3);
    rowIndex += 1
  ) {
    const value = getCell(rows, rowIndex, placingColumnIndex);

    if (value?.trim()) {
      return value;
    }
  }

  return undefined;
}

function findFastestCell(
  rows: string[][],
  headerRowIndex: number,
  timeColumnIndex: number,
): string | undefined {
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex <= Math.min(rows.length - 1, headerRowIndex + 4);
    rowIndex += 1
  ) {
    const value = getCell(rows, rowIndex, timeColumnIndex);

    if (value?.trim()) {
      return value;
    }
  }

  return undefined;
}

function findResultsStartRowIndex(
  rows: string[][],
  headerRowIndex: number,
  placingColumnIndex: number,
): number {
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex <= Math.min(rows.length - 1, headerRowIndex + 5);
    rowIndex += 1
  ) {
    const placingHeader = getCell(rows, rowIndex, placingColumnIndex)?.trim();
    const nameHeader = getCell(rows, rowIndex, placingColumnIndex + 1)?.trim();

    if (
      placingHeader?.toLowerCase() === "position" &&
      nameHeader?.toLowerCase() === "name"
    ) {
      return rowIndex + 1;
    }
  }

  return headerRowIndex + 4;
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

function parseCupNumber(value: string): number {
  const match = value.match(/(\d+)/);

  if (!match) {
    throw new Error(`Unable to parse cup number from header: ${value}`);
  }

  return Number(match[1]);
}

function parseMapMetadata(value: string | undefined): {
  map: string;
  author: string;
} {
  const rawValue = value?.trim() ?? "";
  const withoutPrefix = rawValue.replace(/^Map:\s*/i, "").trim();
  const separatorIndex = withoutPrefix.lastIndexOf(" by ");

  if (separatorIndex === -1) {
    return {
      map: withoutPrefix || "unknown-map",
      author: "unknown-author",
    };
  }

  return {
    map: withoutPrefix.slice(0, separatorIndex).trim() || "unknown-map",
    author: withoutPrefix.slice(separatorIndex + 4).trim() || "unknown-author",
  };
}

function parseFastestMetadata(value: string | undefined): {
  time: string | null;
  driver: string | null;
  round: string | null;
} {
  const rawValue = value?.trim() ?? "";

  if (!rawValue) {
    return {
      time: null,
      driver: null,
      round: null,
    };
  }

  const match = rawValue.match(
    /^Fastest Time:\s*([^\s]+)\s+by\s+(.+?)\s+in\s+(.+)$/i,
  );

  if (!match) {
    return {
      time: null,
      driver: null,
      round: null,
    };
  }

  return {
    time: match[1].trim(),
    driver: match[2].trim(),
    round: match[3].trim(),
  };
}

function parseOptionalNumber(value: string): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCell(
  rows: string[][],
  rowIndex: number,
  columnIndex: number,
): string | undefined {
  return rows[rowIndex]?.[columnIndex];
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate result files: ${message}`);
  process.exitCode = 1;
});
