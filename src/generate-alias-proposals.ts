import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

type AliasList = Record<string, string[]>;

type NameObservation = {
  name: string;
  appearances: number;
  eventNumbers: number[];
  fastestTimeEvents: number[];
  normalizedExact: string;
  normalizedBase: string;
  parentheticalAlias: ParentheticalAlias | null;
};

type ParentheticalAlias = {
  displayName: string;
  hintedName: string;
};

type ProposalEntry = {
  name: string;
  reasons: string[];
  appearances: number;
  firstSeenEvent: number | null;
  lastSeenEvent: number | null;
  exampleEvents: number[];
};

type KnownAliasAddition = {
  canonicalName: string;
  knownAliases: string[];
  proposedAliases: ProposalEntry[];
};

type NewAliasGroup = {
  canonicalSuggestion: string;
  names: ProposalEntry[];
  groupReasons: string[];
};

type AliasProposalFile = {
  generatedAt: string;
  sourceDirectory: string;
  knownAliasFile: string;
  generatedAliasFile: string;
  knownAliasAdditions: KnownAliasAddition[];
  newAliasGroups: NewAliasGroup[];
};

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.join(projectRoot, "results");
const outputDirectory = resultsDirectory;
const aliasListPath = path.join(projectRoot, "data", "player-aliases.json");
const generatedAliasListPath = path.join(
  projectRoot,
  "data",
  "player-aliases.generated.json",
);
const outputPath = path.join(outputDirectory, "player-alias-proposals.json");

async function main(): Promise<void> {
  const knownAliases = await loadKnownAliases();
  const observations = await collectNameObservations();
  const graph = buildAliasGraph(observations);
  const knownAliasAdditions = buildKnownAliasAdditions(
    knownAliases,
    observations,
    graph,
  );
  const newAliasGroups = buildNewAliasGroups(knownAliases, observations, graph);
  const generatedAliases = buildGeneratedAliasList(
    knownAliasAdditions,
    newAliasGroups,
  );

  const output: AliasProposalFile = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: path.relative(projectRoot, resultsDirectory),
    knownAliasFile: path.relative(projectRoot, aliasListPath),
    generatedAliasFile: path.relative(projectRoot, generatedAliasListPath),
    knownAliasAdditions,
    newAliasGroups,
  };

  await writeFile(
    generatedAliasListPath,
    `${JSON.stringify(generatedAliases, null, 2)}\n`,
    "utf8",
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(
    `Generated alias proposals at ${path.relative(projectRoot, outputPath)} and generated aliases at ${path.relative(projectRoot, generatedAliasListPath)} with ${knownAliasAdditions.length} known-group updates and ${newAliasGroups.length} new groups to review.`,
  );
}

function buildGeneratedAliasList(
  knownAliasAdditions: KnownAliasAddition[],
  newAliasGroups: NewAliasGroup[],
): AliasList {
  const generatedAliases: AliasList = {};

  for (const addition of knownAliasAdditions) {
    generatedAliases[addition.canonicalName] = orderAliasNames(
      addition.canonicalName,
      [
        addition.canonicalName,
        ...addition.proposedAliases.map((entry) => entry.name),
      ],
    );
  }

  for (const group of newAliasGroups) {
    generatedAliases[group.canonicalSuggestion] = orderAliasNames(
      group.canonicalSuggestion,
      group.names.map((entry) => entry.name),
    );
  }

  return Object.fromEntries(
    Object.entries(generatedAliases).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function orderAliasNames(canonicalName: string, names: string[]): string[] {
  const canonical = normalizeWhitespace(canonicalName);
  const uniqueNames = Array.from(
    new Set(names.map(normalizeWhitespace).filter((name) => name.length > 0)),
  );
  const otherNames = uniqueNames
    .filter((name) => name !== canonical)
    .sort((left, right) => left.localeCompare(right));

  return [canonical, ...otherNames];
}

async function loadKnownAliases(): Promise<AliasList> {
  const content = await readFile(aliasListPath, "utf8");
  return JSON.parse(content) as AliasList;
}

async function collectNameObservations(): Promise<
  Map<string, NameObservation>
> {
  const fileNames = (await readdir(resultsDirectory))
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
    .filter((fileName) => fileName !== path.basename(outputPath))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  const observations = new Map<string, NameObservation>();

  for (const fileName of fileNames) {
    const content = await readFile(
      path.join(resultsDirectory, fileName),
      "utf8",
    );
    const event = JSON.parse(content) as CupResultFile;

    for (const result of event.results) {
      registerName(observations, result.name, event.nr, false);
    }

    if (event.fastestTimeDriver) {
      registerName(observations, event.fastestTimeDriver, event.nr, true);
    }
  }

  return observations;
}

function registerName(
  observations: Map<string, NameObservation>,
  rawName: string,
  eventNumber: number,
  isFastestTime: boolean,
): void {
  const name = normalizeWhitespace(rawName);

  if (!isLikelyPlayerName(name)) {
    return;
  }

  const existing = observations.get(name);

  if (existing) {
    existing.appearances += 1;

    if (!existing.eventNumbers.includes(eventNumber)) {
      existing.eventNumbers.push(eventNumber);
      existing.eventNumbers.sort((left, right) => left - right);
    }

    if (isFastestTime && !existing.fastestTimeEvents.includes(eventNumber)) {
      existing.fastestTimeEvents.push(eventNumber);
      existing.fastestTimeEvents.sort((left, right) => left - right);
    }

    return;
  }

  observations.set(name, {
    name,
    appearances: 1,
    eventNumbers: [eventNumber],
    fastestTimeEvents: isFastestTime ? [eventNumber] : [],
    normalizedExact: name.toLowerCase(),
    normalizedBase: normalizeBaseName(name),
    parentheticalAlias: parseParentheticalAlias(name),
  });
}

function buildAliasGraph(
  observations: Map<string, NameObservation>,
): Map<string, Map<string, Set<string>>> {
  const graph = new Map<string, Map<string, Set<string>>>();
  const byBase = new Map<string, string[]>();

  for (const observation of observations.values()) {
    if (!byBase.has(observation.normalizedBase)) {
      byBase.set(observation.normalizedBase, []);
    }

    byBase.get(observation.normalizedBase)?.push(observation.name);
  }

  for (const names of byBase.values()) {
    if (names.length < 2) {
      continue;
    }

    for (let index = 0; index < names.length; index += 1) {
      for (
        let innerIndex = index + 1;
        innerIndex < names.length;
        innerIndex += 1
      ) {
        addEdge(
          graph,
          names[index],
          names[innerIndex],
          "shared base name after removing tags/casing",
        );
      }
    }
  }

  for (const observation of observations.values()) {
    if (observation.parentheticalAlias === null) {
      continue;
    }

    const hintedBase = normalizeBaseName(
      observation.parentheticalAlias.hintedName,
    );

    for (const candidate of observations.values()) {
      if (candidate.name === observation.name) {
        continue;
      }

      if (candidate.normalizedBase === hintedBase) {
        addEdge(
          graph,
          observation.name,
          candidate.name,
          "explicit alias hint in parentheses",
        );
      }
    }
  }

  return graph;
}

function buildKnownAliasAdditions(
  knownAliases: AliasList,
  observations: Map<string, NameObservation>,
  graph: Map<string, Map<string, Set<string>>>,
): KnownAliasAddition[] {
  return Object.entries(knownAliases)
    .map(([canonicalName, aliases]) => {
      const knownNames = new Set(
        [canonicalName, ...aliases].map(normalizeWhitespace),
      );
      const proposedAliases = Array.from(observations.keys())
        .filter((name) => !knownNames.has(name))
        .map((name) => ({
          name,
          reasons: collectReasonsToKnownGroup(name, knownNames, graph),
        }))
        .filter((entry) => entry.reasons.length > 0)
        .map((entry) =>
          buildProposalEntry(entry.name, entry.reasons, observations),
        )
        .sort(compareProposalEntries);

      return {
        canonicalName,
        knownAliases: Array.from(knownNames).sort((left, right) =>
          left.localeCompare(right),
        ),
        proposedAliases,
      } satisfies KnownAliasAddition;
    })
    .filter((entry) => entry.proposedAliases.length > 0)
    .sort((left, right) =>
      left.canonicalName.localeCompare(right.canonicalName),
    );
}

function buildNewAliasGroups(
  knownAliases: AliasList,
  observations: Map<string, NameObservation>,
  graph: Map<string, Map<string, Set<string>>>,
): NewAliasGroup[] {
  const knownNames = new Set(
    Object.entries(knownAliases)
      .flatMap(([canonicalName, aliases]) => [canonicalName, ...aliases])
      .map(normalizeWhitespace),
  );
  const visited = new Set<string>();
  const groups: NewAliasGroup[] = [];

  for (const name of observations.keys()) {
    if (visited.has(name) || knownNames.has(name)) {
      continue;
    }

    const component = collectComponent(name, graph);

    for (const componentName of component) {
      visited.add(componentName);
    }

    if (component.some((componentName) => knownNames.has(componentName))) {
      continue;
    }

    const filteredComponent = component.filter(
      (componentName) => !knownNames.has(componentName),
    );

    if (filteredComponent.length < 2) {
      continue;
    }

    const groupReasons = collectComponentReasons(filteredComponent, graph);

    groups.push({
      canonicalSuggestion: selectCanonicalSuggestion(
        filteredComponent,
        observations,
      ),
      names: filteredComponent
        .map((componentName) =>
          buildProposalEntry(
            componentName,
            collectReasonsWithinComponent(
              componentName,
              filteredComponent,
              graph,
            ),
            observations,
          ),
        )
        .sort(compareProposalEntries),
      groupReasons,
    });
  }

  return groups.sort((left, right) => {
    if (right.names.length !== left.names.length) {
      return right.names.length - left.names.length;
    }

    return left.canonicalSuggestion.localeCompare(right.canonicalSuggestion);
  });
}

function collectReasonsToKnownGroup(
  name: string,
  knownNames: Set<string>,
  graph: Map<string, Map<string, Set<string>>>,
): string[] {
  const reasons = new Set<string>();
  const edges = graph.get(name);

  if (!edges) {
    return [];
  }

  for (const knownName of knownNames) {
    const directReasons = edges.get(knownName);

    if (!directReasons) {
      continue;
    }

    for (const reason of directReasons) {
      reasons.add(reason);
    }
  }

  return Array.from(reasons).sort((left, right) => left.localeCompare(right));
}

function collectComponent(
  startName: string,
  graph: Map<string, Map<string, Set<string>>>,
): string[] {
  const queue = [startName];
  const visited = new Set<string>([startName]);

  for (let index = 0; index < queue.length; index += 1) {
    const currentName = queue[index];
    const neighbors = graph.get(currentName);

    if (!neighbors) {
      continue;
    }

    for (const neighbor of neighbors.keys()) {
      if (visited.has(neighbor)) {
        continue;
      }

      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return queue.sort((left, right) => left.localeCompare(right));
}

function collectComponentReasons(
  component: string[],
  graph: Map<string, Map<string, Set<string>>>,
): string[] {
  const reasons = new Set<string>();

  for (const name of component) {
    const edges = graph.get(name);

    if (!edges) {
      continue;
    }

    for (const otherName of component) {
      if (name === otherName) {
        continue;
      }

      const edgeReasons = edges.get(otherName);

      if (!edgeReasons) {
        continue;
      }

      for (const reason of edgeReasons) {
        reasons.add(reason);
      }
    }
  }

  return Array.from(reasons).sort((left, right) => left.localeCompare(right));
}

function collectReasonsWithinComponent(
  name: string,
  component: string[],
  graph: Map<string, Map<string, Set<string>>>,
): string[] {
  const reasons = new Set<string>();
  const edges = graph.get(name);

  if (!edges) {
    return [];
  }

  for (const componentName of component) {
    if (componentName === name) {
      continue;
    }

    const edgeReasons = edges.get(componentName);

    if (!edgeReasons) {
      continue;
    }

    for (const reason of edgeReasons) {
      reasons.add(reason);
    }
  }

  return Array.from(reasons).sort((left, right) => left.localeCompare(right));
}

function buildProposalEntry(
  name: string,
  reasons: string[],
  observations: Map<string, NameObservation>,
): ProposalEntry {
  const observation = observations.get(name);

  if (!observation) {
    throw new Error(`Missing observation for ${name}`);
  }

  return {
    name,
    reasons,
    appearances: observation.appearances,
    firstSeenEvent: observation.eventNumbers[0] ?? null,
    lastSeenEvent: observation.eventNumbers.at(-1) ?? null,
    exampleEvents: observation.eventNumbers.slice(0, 8),
  };
}

function compareProposalEntries(
  left: ProposalEntry,
  right: ProposalEntry,
): number {
  if (right.appearances !== left.appearances) {
    return right.appearances - left.appearances;
  }

  if (
    (left.firstSeenEvent ?? Number.MAX_SAFE_INTEGER) !==
    (right.firstSeenEvent ?? Number.MAX_SAFE_INTEGER)
  ) {
    return (
      (left.firstSeenEvent ?? Number.MAX_SAFE_INTEGER) -
      (right.firstSeenEvent ?? Number.MAX_SAFE_INTEGER)
    );
  }

  return left.name.localeCompare(right.name);
}

function selectCanonicalSuggestion(
  names: string[],
  observations: Map<string, NameObservation>,
): string {
  return [...names].sort((left, right) => {
    const leftScore = scoreCanonicalName(left, observations.get(left));
    const rightScore = scoreCanonicalName(right, observations.get(right));

    for (let index = 0; index < leftScore.length; index += 1) {
      if (leftScore[index] !== rightScore[index]) {
        return leftScore[index] - rightScore[index];
      }
    }

    return left.localeCompare(right);
  })[0];
}

function scoreCanonicalName(
  name: string,
  observation?: NameObservation,
): number[] {
  const normalized = normalizeWhitespace(name);
  const hasLeadingTag = normalized !== stripLeadingTags(normalized) ? 1 : 0;
  const hasParentheticalHint = parseParentheticalAlias(normalized) ? 1 : 0;
  const wordCountPenalty = Math.max(normalized.split(/\s+/).length - 1, 0);
  const appearancePenalty = observation ? -observation.appearances : 0;

  return [
    hasLeadingTag,
    hasParentheticalHint,
    wordCountPenalty,
    normalized.length,
    appearancePenalty,
  ];
}

function addEdge(
  graph: Map<string, Map<string, Set<string>>>,
  left: string,
  right: string,
  reason: string,
): void {
  if (left === right) {
    return;
  }

  if (!graph.has(left)) {
    graph.set(left, new Map());
  }

  if (!graph.has(right)) {
    graph.set(right, new Map());
  }

  if (!graph.get(left)?.has(right)) {
    graph.get(left)?.set(right, new Set());
  }

  if (!graph.get(right)?.has(left)) {
    graph.get(right)?.set(left, new Set());
  }

  graph.get(left)?.get(right)?.add(reason);
  graph.get(right)?.get(left)?.add(reason);
}

function normalizeBaseName(name: string): string {
  return stripLeadingTags(normalizeWhitespace(name)).toLowerCase();
}

function stripLeadingTags(name: string): string {
  let remaining = normalizeWhitespace(name);

  while (remaining.startsWith("[")) {
    const bracketedTag = remaining.match(/^\[[^\]]+\]\s*/);

    if (bracketedTag) {
      remaining = remaining.slice(bracketedTag[0].length).trim();
      continue;
    }

    const malformedTag = remaining.match(/^\[[^\s]+\s*/);

    if (malformedTag) {
      remaining = remaining.slice(malformedTag[0].length).trim();
      continue;
    }

    break;
  }

  return remaining;
}

function parseParentheticalAlias(name: string): ParentheticalAlias | null {
  const normalized = normalizeWhitespace(name);
  const match = normalized.match(/^(.+?)\s*\(([^()]+)\)$/);

  if (!match) {
    return null;
  }

  const displayName = normalizeWhitespace(match[1]);
  const hintedName = normalizeWhitespace(match[2]);

  if (!displayName || !hintedName) {
    return null;
  }

  if (!isLikelyPlayerName(displayName) || !isLikelyPlayerName(hintedName)) {
    return null;
  }

  if (/^round\s+\d+$/i.test(hintedName)) {
    return null;
  }

  return {
    displayName,
    hintedName,
  };
}

function isLikelyPlayerName(name: string): boolean {
  const normalized = normalizeWhitespace(name);

  if (!normalized) {
    return false;
  }

  const lowered = normalized.toLowerCase();
  const blockedPhrases = [
    "time of leaving",
    "at the time of leaving",
    "would not have",
    "despite not being knocked out",
    "due to disconnection",
    "awarded joint",
    "had to leave",
    "leave mid-tournament",
    "prevented",
  ];

  if (blockedPhrases.some((phrase) => lowered.includes(phrase))) {
    return false;
  }

  if (/\d+\.\d+/.test(normalized) && /\s/.test(normalized)) {
    return false;
  }

  const wordCount = normalized.split(/\s+/).length;

  if (wordCount > 6 && !normalized.startsWith("[")) {
    return false;
  }

  return true;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate alias proposals: ${message}`);
  process.exitCode = 1;
});
