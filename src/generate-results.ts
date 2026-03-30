import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "csv-parse/sync";

type CompetitionType = "cotd" | "roulette" | "troll";

import { isCommentResultName, normalizePlayerName } from "./lib/player-names";

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

type CupBlock = {
  competitionType: CompetitionType;
  competitionLabel: string;
  eventLabel: string;
  filePrefix: string;
  nr: number;
  headerRowIndex: number;
  placingColumnIndex: number;
};

type CompetitionHeader = {
  competitionType: CompetitionType;
  competitionLabel: string;
  eventLabel: string;
  filePrefix: string;
  nr: number;
};

const projectRoot = path.resolve(__dirname, "..");
const sourceCsvDirectory = path.join(projectRoot, "data", "source-csvs");
const outputDirectory = path.join(projectRoot, "data", "generated-jsons");

async function main(): Promise<void> {
  const dataFiles = await readdir(sourceCsvDirectory);
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
          fileName !== "player-alias-proposals.json",
      )
      .map((fileName) =>
        rm(path.join(outputDirectory, fileName), { force: true }),
      ),
  );

  let generatedFileCount = 0;

  for (const csvFileName of csvFiles) {
    const sourcePath = path.join(sourceCsvDirectory, csvFileName);
    const csvContent = await readFile(sourcePath, "utf8");
    const rows = parse(csvContent, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
      trim: false,
    }) as string[][];

    for (const cupBlock of detectCupBlocks(rows)) {
      const cupData = extractCup(rows, cupBlock, csvFileName);
      const fileName = `${cupBlock.filePrefix}-${cupData.nr}-${slugify(cupData.map)}-${slugify(cupData.author)}.json`;
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
  const seenCupKeys = new Set<string>();

  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const header = parseCompetitionHeader(value);

      if (!header) {
        continue;
      }

      const cupKey = `${header.competitionType}:${header.nr}`;

      if (seenCupKeys.has(cupKey)) {
        continue;
      }

      seenCupKeys.add(cupKey);
      cupBlocks.push({
        ...header,
        headerRowIndex: rowIndex,
        placingColumnIndex: columnIndex,
      });
    }
  }

  return cupBlocks.sort(
    (left, right) =>
      getCompetitionOrder(left.competitionType) -
        getCompetitionOrder(right.competitionType) || left.nr - right.nr,
  );
}

function parseCompetitionHeader(
  value: string | undefined,
): CompetitionHeader | null {
  const normalizedValue = normalizeWhitespace(
    stripWrappingQuotes(value?.trim() ?? ""),
  );

  if (!normalizedValue) {
    return null;
  }

  const rouletteMatch = normalizedValue.match(/^COTD Roulette\s+(\d+)\b/i);

  if (rouletteMatch) {
    const nr = Number(rouletteMatch[1]);

    return {
      competitionType: "roulette",
      competitionLabel: "Cup of the Day Roulette",
      eventLabel: `COTD Roulette ${nr}`,
      filePrefix: "roulette",
      nr,
    };
  }

  const trollMatch = normalizedValue.match(/^Troll COT[DW]\s+(\d+)\b/i);

  if (trollMatch) {
    return {
      competitionType: "troll",
      competitionLabel: "Troll Cup of the Day",
      eventLabel: normalizedValue,
      filePrefix: "troll",
      nr: Number(trollMatch[1]),
    };
  }

  const cotdMatch = normalizedValue.match(/^COT[DW]\s+(\d+)\b/i);

  if (cotdMatch) {
    return {
      competitionType: "cotd",
      competitionLabel: "Cup of the Day",
      eventLabel: normalizedValue,
      filePrefix: "cotd",
      nr: Number(cotdMatch[1]),
    };
  }

  return null;
}

function extractCup(
  rows: string[][],
  cupBlock: CupBlock,
  sourceFileName: string,
): CupResultFile {
  const resultsHeaderRowIndex = findResultsHeaderRowIndex(
    rows,
    cupBlock.headerRowIndex,
    cupBlock.placingColumnIndex,
  );
  const indexes = {
    placing: cupBlock.placingColumnIndex,
    name: cupBlock.placingColumnIndex + 1,
    time: cupBlock.placingColumnIndex + 2,
    eliminationRound: cupBlock.placingColumnIndex + 3,
    rouletteMap:
      cupBlock.competitionType === "roulette"
        ? cupBlock.placingColumnIndex + 4
        : undefined,
    rouletteMapper:
      cupBlock.competitionType === "roulette"
        ? cupBlock.placingColumnIndex + 5
        : undefined,
    rouletteSource:
      cupBlock.competitionType === "roulette"
        ? cupBlock.placingColumnIndex + 6
        : undefined,
  };
  const results = extractResults(rows, indexes, resultsHeaderRowIndex + 1);

  if (cupBlock.competitionType === "roulette") {
    return {
      competitionType: cupBlock.competitionType,
      competitionLabel: cupBlock.competitionLabel,
      eventLabel: cupBlock.eventLabel,
      nr: cupBlock.nr,
      map: "Various",
      author: "Various",
      description: parseRouletteDescription(
        findMapCell(rows, cupBlock.headerRowIndex, indexes.placing),
      ),
      fastestTime: null,
      fastestTimeDriver: null,
      fastestTimeRound: null,
      rouletteSourceLabel: normalizeOptionalText(
        getCell(rows, resultsHeaderRowIndex, indexes.rouletteSource ?? -1),
      ),
      sourceFile: sourceFileName,
      results,
    };
  }

  const mapMetadata = parseMapMetadata(
    findMapCell(rows, cupBlock.headerRowIndex, indexes.placing),
  );
  const fastestMetadata = parseFastestMetadata(
    findFastestCell(rows, cupBlock.headerRowIndex, indexes.time),
  );

  return {
    competitionType: cupBlock.competitionType,
    competitionLabel: cupBlock.competitionLabel,
    eventLabel: cupBlock.eventLabel,
    nr: cupBlock.nr,
    map: mapMetadata.map,
    author: mapMetadata.author,
    description: null,
    fastestTime: fastestMetadata.time,
    fastestTimeDriver: fastestMetadata.driver,
    fastestTimeRound: fastestMetadata.round,
    rouletteSourceLabel: null,
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
    rouletteMap?: number;
    rouletteMapper?: number;
    rouletteSource?: number;
  },
  startRowIndex: number,
): ResultEntry[] {
  const results: ResultEntry[] = [];
  let currentPlacing: number | null = null;

  for (let rowIndex = startRowIndex; rowIndex < rows.length; rowIndex += 1) {
    const name = normalizePlayerName(
      getCell(rows, rowIndex, indexes.name) ?? "",
    );
    const placingValue = getCell(rows, rowIndex, indexes.placing)?.trim() ?? "";
    const time = getCell(rows, rowIndex, indexes.time)?.trim() ?? "";
    const eliminationRound =
      getCell(rows, rowIndex, indexes.eliminationRound)?.trim() ?? "";

    if (!name && !placingValue && !time && !eliminationRound) {
      continue;
    }

    if (!name || isCommentResultName(name)) {
      continue;
    }

    const parsedPlacing = parseOptionalNumber(placingValue);

    if (parsedPlacing !== null) {
      currentPlacing = parsedPlacing;
    }

    const normalizedPlacing = parsedPlacing ?? currentPlacing;
    const normalizedEliminationRound = eliminationRound || null;

    results.push({
      placing: normalizedPlacing,
      name,
      time,
      eliminationRound: normalizedEliminationRound,
      rouletteMap: normalizeOptionalText(
        getCell(rows, rowIndex, indexes.rouletteMap ?? -1),
      ),
      rouletteMapper: normalizeOptionalPlayerText(
        getCell(rows, rowIndex, indexes.rouletteMapper ?? -1),
      ),
      rouletteSourceEventNumber: parseOptionalNumber(
        getCell(rows, rowIndex, indexes.rouletteSource ?? -1)?.trim() ?? "",
      ),
    });
  }

  return normalizeAllDnfRoundPlacings(results);
}

function normalizeAllDnfRoundPlacings(results: ResultEntry[]): ResultEntry[] {
  const normalizedResults = results.map((result) => ({ ...result }));

  propagateMissingRoundWithinTiedDnfGroups(normalizedResults);

  for (let startIndex = 0; startIndex < normalizedResults.length; ) {
    const eliminationRound = normalizedResults[startIndex]?.eliminationRound;

    if (!eliminationRound) {
      startIndex += 1;
      continue;
    }

    let endIndex = startIndex + 1;

    while (
      endIndex < normalizedResults.length &&
      normalizedResults[endIndex]?.eliminationRound === eliminationRound
    ) {
      endIndex += 1;
    }

    const group = normalizedResults.slice(startIndex, endIndex);

    if (!group.every((result) => isDnfTime(result.time))) {
      startIndex = endIndex;
      continue;
    }

    const lowestPlacingInRound = countPlayersLeftInRound(
      normalizedResults,
      eliminationRound,
    );
    const highestPlacingInRound = Math.max(
      1,
      lowestPlacingInRound - group.length + 1,
    );

    for (let index = startIndex; index < endIndex; index += 1) {
      normalizedResults[index] = {
        ...normalizedResults[index],
        placing: highestPlacingInRound,
      };
    }

    startIndex = endIndex;
  }

  return normalizedResults;
}

function countPlayersLeftInRound(
  results: ResultEntry[],
  eliminationRound: string,
): number {
  const targetRound = Number(eliminationRound);

  if (!Number.isFinite(targetRound)) {
    return results.length;
  }

  return results.filter((result) => {
    if (!result.eliminationRound) {
      return true;
    }

    const resultRound = Number(result.eliminationRound);
    return Number.isFinite(resultRound) && resultRound >= targetRound;
  }).length;
}

function propagateMissingRoundWithinTiedDnfGroups(
  results: ResultEntry[],
): void {
  for (let startIndex = 0; startIndex < results.length; ) {
    const placing = results[startIndex]?.placing;

    let endIndex = startIndex + 1;

    while (
      endIndex < results.length &&
      results[endIndex]?.placing === placing
    ) {
      endIndex += 1;
    }

    const group = results.slice(startIndex, endIndex);
    const sharedRound =
      group.find((result) => result.eliminationRound)?.eliminationRound ?? null;

    if (sharedRound && group.every((result) => isDnfTime(result.time))) {
      for (let index = startIndex; index < endIndex; index += 1) {
        if (!results[index]?.eliminationRound) {
          results[index] = {
            ...results[index],
            eliminationRound: sharedRound,
          };
        }
      }
    }

    startIndex = endIndex;
  }
}

function isDnfTime(value: string): boolean {
  return /^dnf\*?$/i.test(value.trim());
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

function findResultsHeaderRowIndex(
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
      return rowIndex;
    }
  }

  return headerRowIndex + 3;
}

function parseMapMetadata(value: string | undefined): {
  map: string;
  author: string;
} {
  const rawValue = normalizeWhitespace(
    stripWrappingQuotes(value?.trim() ?? ""),
  );
  const withoutPrefix = rawValue.replace(/^(?:Map|Level Pack):\s*/i, "").trim();
  const separatorIndex = withoutPrefix.lastIndexOf(" by ");

  if (separatorIndex === -1) {
    return {
      map: withoutPrefix || "unknown-map",
      author: "unknown-author",
    };
  }

  return {
    map: withoutPrefix.slice(0, separatorIndex).trim() || "unknown-map",
    author:
      normalizePlayerName(withoutPrefix.slice(separatorIndex + 4)) ||
      "unknown-author",
  };
}

function parseRouletteDescription(value: string | undefined): string | null {
  const rawValue = normalizeWhitespace(
    stripWrappingQuotes(value?.trim() ?? ""),
  );
  const description = rawValue.replace(/^Map:\s*/i, "").trim();
  return description || null;
}

function parseFastestMetadata(value: string | undefined): {
  time: string | null;
  driver: string | null;
  round: string | null;
} {
  const rawValue = normalizeWhitespace(
    stripWrappingQuotes(value?.trim() ?? ""),
  );

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
    driver: normalizePlayerName(match[2] ?? "") || null,
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

function normalizeOptionalText(value: string | undefined): string | null {
  const normalized = normalizeWhitespace(
    stripWrappingQuotes(value?.trim() ?? ""),
  );
  return normalized || null;
}

function normalizeOptionalPlayerText(value: string | undefined): string | null {
  const normalized = normalizePlayerName(
    stripWrappingQuotes(value?.trim() ?? ""),
  );
  return normalized || null;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function getCell(
  rows: string[][],
  rowIndex: number,
  columnIndex: number,
): string | undefined {
  return rows[rowIndex]?.[columnIndex];
}

function getCompetitionOrder(competitionType: CompetitionType): number {
  switch (competitionType) {
    case "cotd":
      return 0;
    case "roulette":
      return 1;
    case "troll":
      return 2;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
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
