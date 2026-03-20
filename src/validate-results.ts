import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type CompetitionType = "cotd" | "roulette" | "troll";

type CupResultFile = {
  competitionType: CompetitionType;
  nr: number;
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "data", "generated-jsons");

async function main(): Promise<void> {
  const fileNames = await readdir(resultsDirectory);
  const eventNumbers = (
    await Promise.all(
      fileNames
        .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
        .filter((fileName) => fileName !== "player-alias-proposals.json")
        .map(async (fileName) => {
          const content = await readFile(
            path.join(resultsDirectory, fileName),
            "utf8",
          );
          const event = JSON.parse(content) as CupResultFile;

          return event.competitionType === "cotd" ? event.nr : null;
        }),
    )
  )
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (eventNumbers.length === 0) {
    throw new Error(
      "No generated event result files were found in data/generated-jsons/.",
    );
  }

  const duplicates = eventNumbers.filter(
    (value, index) => index > 0 && value === eventNumbers[index - 1],
  );

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate event numbers found: ${Array.from(new Set(duplicates)).join(", ")}`,
    );
  }

  const highestEventNumber = eventNumbers[eventNumbers.length - 1] ?? 0;
  const presentEventNumbers = new Set(eventNumbers);
  const missingEventNumbers: number[] = [];

  for (
    let eventNumber = 1;
    eventNumber <= highestEventNumber;
    eventNumber += 1
  ) {
    if (!presentEventNumbers.has(eventNumber)) {
      missingEventNumbers.push(eventNumber);
    }
  }

  if (missingEventNumbers.length > 0) {
    throw new Error(`Missing event numbers: ${missingEventNumbers.join(", ")}`);
  }

  console.log(
    `Validated ${eventNumbers.length} Cup of the Day result files with no missing event numbers through ${highestEventNumber}.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Result validation failed: ${message}`);
  process.exitCode = 1;
});
