import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isCommentResultName, normalizeWhitespace } from "./player-names";

export type CompetitionType = "cotd" | "roulette" | "troll";

export type ResultEntry = {
  placing: number | null;
  name: string;
  time: string;
  eliminationRound: string | null;
  rouletteMap: string | null;
  rouletteMapper: string | null;
  rouletteSourceEventNumber: number | null;
};

export type CupResultFile = {
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

export type EventRecord = CupResultFile & {
  eventKey: string;
  sortOrder: number;
  jsonFileName: string;
  htmlFileName: string;
  podium: Array<{ placing: number; entries: ResultEntry[] }>;
  authors: string[];
};

export type CompetitionDefinition = {
  type: CompetitionType;
  label: string;
  shortLabel: string;
};

export const competitionDefinitions: CompetitionDefinition[] = [
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

export async function loadEventRecords(
  resultsDirectory: string,
): Promise<EventRecord[]> {
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

export function compareEventRecords(
  left: EventRecord,
  right: EventRecord,
): number {
  return (
    getCompetitionOrder(left.competitionType) -
      getCompetitionOrder(right.competitionType) ||
    left.nr - right.nr ||
    left.eventLabel.localeCompare(right.eventLabel)
  );
}

export function getCompetitionEventRecords(
  eventRecords: EventRecord[],
  competitionType: CompetitionType,
): EventRecord[] {
  return eventRecords.filter(
    (eventRecord) => eventRecord.competitionType === competitionType,
  );
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

function getCompetitionOrder(competitionType: CompetitionType): number {
  return competitionDefinitions.findIndex(
    (definition) => definition.type === competitionType,
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
