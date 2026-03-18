import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "csv-parse/sync";

import { csvIndexes } from "../data/indexes";

type CupSlot = keyof typeof csvIndexes;

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

const projectRoot = path.resolve(__dirname, "..");
const dataDirectory = path.join(projectRoot, "data");
const outputDirectory = path.join(projectRoot, "results");
const headerRowIndex = 1;
const mapRowIndex = 2;
const fastestRowIndex = 3;
const resultsStartRowIndex = 5;

async function main(): Promise<void> {
  const dataFiles = await readdir(dataDirectory);
  const csvFiles = dataFiles
    .filter((fileName) => fileName.toLowerCase().endsWith(".csv"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  await mkdir(outputDirectory, { recursive: true });

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

    for (const slot of getCupSlots()) {
      const cupData = extractCup(rows, slot, csvFileName);

      if (cupData === null) {
        continue;
      }

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

function getCupSlots(): CupSlot[] {
  return Object.keys(csvIndexes)
    .map((value) => Number(value) as CupSlot)
    .sort((left, right) => Number(left) - Number(right));
}

function extractCup(
  rows: string[][],
  slot: CupSlot,
  sourceFileName: string,
): CupResultFile | null {
  const indexes = csvIndexes[slot];
  const cupHeader = getCell(rows, headerRowIndex, indexes.placing)?.trim();

  if (!cupHeader) {
    return null;
  }

  const nr = parseCupNumber(cupHeader);
  const mapMetadata = parseMapMetadata(
    getCell(rows, mapRowIndex, indexes.placing),
  );
  const fastestMetadata = parseFastestMetadata(
    getCell(rows, fastestRowIndex, indexes.time),
  );
  const results = extractResults(rows, indexes);

  return {
    nr,
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
  indexes: (typeof csvIndexes)[CupSlot],
): ResultEntry[] {
  const results: ResultEntry[] = [];
  let currentPlacing: number | null = null;

  for (
    let rowIndex = resultsStartRowIndex;
    rowIndex < rows.length;
    rowIndex += 1
  ) {
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
