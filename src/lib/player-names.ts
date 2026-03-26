import { readFile } from "node:fs/promises";

type AliasList = Record<string, string[]>;
type DisplayOnlyNameList = string[];

export type AliasResolver = {
  canonicalByName: Map<string, string>;
  aliasesByCanonical: Map<string, string[]>;
};

export async function loadAliasResolver(
  manualAliasListPath: string,
  generatedAliasListPath: string,
): Promise<AliasResolver> {
  const [manualAliases, generatedAliases] = await Promise.all([
    loadAliasList(manualAliasListPath, false),
    loadAliasList(generatedAliasListPath, true),
  ]);

  const aliasGraph = new Map<string, Set<string>>();
  const manualCanonicalOrder = new Map<string, number>();
  const generatedCanonicalOrder = new Map<string, number>();

  registerAliasList(manualAliases, aliasGraph, manualCanonicalOrder);
  registerAliasList(generatedAliases, aliasGraph, generatedCanonicalOrder);

  const canonicalByName = new Map<string, string>();
  const aliasesByCanonical = new Map<string, string[]>();
  const visited = new Set<string>();

  for (const name of Array.from(aliasGraph.keys()).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (visited.has(name)) {
      continue;
    }

    const stack = [name];
    const component: string[] = [];
    visited.add(name);

    while (stack.length > 0) {
      const current = stack.pop();

      if (!current) {
        continue;
      }

      component.push(current);

      for (const neighbor of aliasGraph.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    const sortedComponent = component.sort((left, right) =>
      left.localeCompare(right),
    );
    const canonicalName = pickCanonicalName(
      sortedComponent,
      manualCanonicalOrder,
      generatedCanonicalOrder,
    );

    aliasesByCanonical.set(canonicalName, sortedComponent);

    for (const alias of sortedComponent) {
      canonicalByName.set(alias, canonicalName);
    }
  }

  return {
    canonicalByName,
    aliasesByCanonical,
  };
}

export async function loadDisplayOnlyNames(
  displayOnlyNameListPath: string,
): Promise<Set<string>> {
  const content = await readFile(displayOnlyNameListPath, "utf8");
  const names = JSON.parse(content) as DisplayOnlyNameList;

  return new Set(names.map(normalizeDisplayOnlyName).filter(Boolean));
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizePlayerName(value: string): string {
  const normalized = normalizeWhitespace(value);

  if (!normalized.startsWith("[")) {
    return normalized;
  }

  let remaining = normalized;
  let rebuilt = "";
  let normalizedTagCount = 0;

  while (remaining.startsWith("[")) {
    const match = remaining.match(/^\[([^\]\[}]+)([\]\[}])(\s*)/);

    if (!match) {
      break;
    }

    const tag = normalizeWhitespace(match[1] ?? "");

    if (!tag) {
      break;
    }

    rebuilt += `[${tag}]${match[3] ?? ""}`;
    remaining = remaining.slice(match[0].length);
    normalizedTagCount += 1;
  }

  if (normalizedTagCount === 0) {
    return normalized;
  }

  return normalizeWhitespace(`${rebuilt}${remaining}`);
}

export function resolveAlias(
  name: string,
  aliasResolver: AliasResolver,
): string {
  const normalizedName = normalizePlayerName(name);
  return aliasResolver.canonicalByName.get(normalizedName) ?? normalizedName;
}

export function isDisplayOnlyName(
  name: string,
  aliasResolver: AliasResolver,
  displayOnlyNames: Set<string>,
): boolean {
  const normalizedName = normalizeWhitespace(name);
  const canonicalName = resolveAlias(normalizedName, aliasResolver);

  return (
    displayOnlyNames.has(normalizeDisplayOnlyName(normalizedName)) ||
    displayOnlyNames.has(normalizeDisplayOnlyName(canonicalName))
  );
}

export function isCommentResultName(value: string): boolean {
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

async function loadAliasList(
  filePath: string,
  optional: boolean,
): Promise<AliasList> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as AliasList;
  } catch (error: unknown) {
    if (
      optional &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }

    throw error;
  }
}

function registerAliasList(
  aliasList: AliasList,
  aliasGraph: Map<string, Set<string>>,
  canonicalOrder: Map<string, number>,
): void {
  for (const [index, [rawCanonicalName, rawAliases]] of Object.entries(
    aliasList,
  ).entries()) {
    const canonicalName = normalizePlayerName(rawCanonicalName);
    canonicalOrder.set(canonicalName, index);

    const aliases = [canonicalName, ...rawAliases]
      .map(normalizePlayerName)
      .filter((name) => name.length > 0);

    for (const alias of aliases) {
      if (!aliasGraph.has(alias)) {
        aliasGraph.set(alias, new Set());
      }

      if (!aliasGraph.has(canonicalName)) {
        aliasGraph.set(canonicalName, new Set());
      }

      aliasGraph.get(canonicalName)?.add(alias);
      aliasGraph.get(alias)?.add(canonicalName);
    }
  }
}

function pickCanonicalName(
  names: string[],
  manualCanonicalOrder: Map<string, number>,
  generatedCanonicalOrder: Map<string, number>,
): string {
  const manualCandidates = names
    .filter((name) => manualCanonicalOrder.has(name))
    .sort(
      (left, right) =>
        (manualCanonicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (manualCanonicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  if (manualCandidates.length > 0) {
    return manualCandidates[0];
  }

  const generatedCandidates = names
    .filter((name) => generatedCanonicalOrder.has(name))
    .sort(
      (left, right) =>
        (generatedCanonicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (generatedCanonicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );

  if (generatedCandidates.length > 0) {
    return generatedCandidates[0];
  }

  return names[0] ?? "Unknown";
}

function normalizeDisplayOnlyName(value: string): string {
  return normalizePlayerName(value).toLowerCase();
}
