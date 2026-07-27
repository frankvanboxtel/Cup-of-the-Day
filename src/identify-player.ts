/**
 * identify-player.ts
 *
 * Estimates which known players are most likely to be the same person as a
 * given "mystery" player, using only objective race-data signals.
 *
 * Usage:
 *   pnpm tsx src/identify-player.ts <mystery-player-name> [suspect1] [suspect2] ...
 *
 * If no suspects are supplied, every player in the dataset is evaluated.
 *
 * Example:
 *   pnpm tsx src/identify-player.ts rtm_lover2007 Sterben Linzi jandje Butter "Cbad Cruiser"
 */

import path from "node:path";
import { loadEventRecords, type EventRecord } from "./lib/event-data";
import { loadAliasResolver, resolveAlias, type AliasResolver } from "./lib/player-names";

// ─── paths ───────────────────────────────────────────────────────────────────

const projectRoot = path.resolve(import.meta.dirname, "..");
const jsonDir = path.join(projectRoot, "data", "generated-jsons");
const manualAliasPath = path.join(projectRoot, "preferences", "player-aliases.json");
const generatedAliasPath = path.join(projectRoot, "preferences", "player-aliases.generated.json");

// ─── types ────────────────────────────────────────────────────────────────────

interface RaceEntry {
  eventNr: number;
  eventLabel: string;
  competitionType: string;
  placing: number;
  fieldSize: number;
  /** placing / fieldSize  (lower = better) */
  placingPercentile: number;
  /** Pace score 0-100 from the raw time delta vs winner */
  paceScore: number | null;
  eliminationRound: number | null;
  maxRound: number | null;
}

interface PlayerProfile {
  canonicalName: string;
  races: RaceEntry[];
  racedEventNrs: Set<number>;
  avgPercentile: number;
  avgPaceScore: number;
  avgEliminationDepth: number; // avg (eliminationRound / maxRound) where available
}

// ─── factor weights (must sum to 1.0) ────────────────────────────────────────

const WEIGHTS = {
  /**
   * Hard exclusion: suspect raced in the SAME event as the mystery player.
   * Two different people cannot share a seat, so this eliminates the suspect.
   */
  scheduling: 0.40,

  /**
   * Skill level match: how close is the suspect's avg placing-percentile to
   * the mystery player's? Uses a Gaussian similarity kernel.
   */
  skillMatch: 0.25,

  /**
   * Pace score match: raw speed similarity across shared event contexts.
   */
  paceMatch: 0.15,

  /**
   * Elimination depth match: how deep does the player typically survive?
   */
  depthMatch: 0.10,

  /**
   * Participation density: similar number of races per available event window.
   */
  densityMatch: 0.10,
} as const;

const TOP_N = 100;

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: pnpm tsx src/identify-player.ts <mystery-player> [suspect ...]");
    process.exit(1);
  }

  const [mysteryArg, ...suspectArgs] = args;

  const aliasResolver = await loadAliasResolver(manualAliasPath, generatedAliasPath);
  const events = await loadEventRecords(jsonDir);

  // Resolve mystery player canonical name
  const mysteryCanonical = resolveAlias(mysteryArg, aliasResolver);

  // Build profiles for every player who has appeared at least once
  const profiles = buildAllProfiles(events, aliasResolver);

  const mysteryProfile = profiles.get(mysteryCanonical);
  if (!mysteryProfile || mysteryProfile.races.length === 0) {
    console.error(`No race data found for mystery player: "${mysteryArg}" (resolved: "${mysteryCanonical}")`);
    console.error("Known players with races:", [...profiles.values()].filter(p => p.races.length > 0).map(p => p.canonicalName).sort().join(", "));
    process.exit(1);
  }

  // Resolve suspect canonical names; default to everyone if none provided
  const suspectCanonicals: string[] =
    suspectArgs.length > 0
      ? suspectArgs.map((s) => resolveAlias(s, aliasResolver))
      : [...profiles.keys()].filter((c) => c !== mysteryCanonical);

  // Score each suspect
  const results: Array<{ name: string; score: number; breakdown: Record<string, number>; disqualified: boolean }> = [];

  for (const suspect of suspectCanonicals) {
    if (suspect === mysteryCanonical) continue;
    const suspectProfile = profiles.get(suspect);
    if (!suspectProfile) {
      console.warn(`  [warn] No data for "${suspect}" — skipped`);
      continue;
    }
    const { score, breakdown, disqualified } = scoreCandidate(mysteryProfile, suspectProfile);
    results.push({ name: suspect, score, breakdown, disqualified });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // ── output ──────────────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(` Identity analysis for mystery player: ${mysteryCanonical}`);
  console.log(`═══════════════════════════════════════════════════════════════════`);
  console.log(` Mystery player profile:`);
  console.log(`   Events raced  : ${mysteryProfile.races.length}`);
  console.log(`   Events         : ${mysteryProfile.races.map(r => r.eventLabel).join(", ")}`);
  console.log(`   Avg percentile : ${(mysteryProfile.avgPercentile * 100).toFixed(1)}%  (lower = better)`);
  console.log(`   Avg pace score : ${mysteryProfile.avgPaceScore.toFixed(1)} / 100`);
  console.log(`   Avg elim depth : ${(mysteryProfile.avgEliminationDepth * 100).toFixed(1)}%  (higher = deeper)`);
  console.log(`───────────────────────────────────────────────────────────────────`);
  console.log(` Suspects ranked by likelihood:\n`);

  const qualified = results.filter((r) => !r.disqualified);
  const topQualified = qualified.slice(0, TOP_N);

  if (topQualified.length === 0) {
    console.log("  No qualifying suspects found.");
  } else {
    console.log(`  Showing top ${Math.min(TOP_N, qualified.length)} of ${qualified.length} qualifying suspects.\n`);
    const maxScore = topQualified[0].score;
    for (const [index, r] of topQualified.entries()) {
      const pct = maxScore > 0 ? ((r.score / maxScore) * 100).toFixed(1) : "0.0";
      const total = formatFixedMetric(r.score * 100);
      const skill = formatFixedMetric(r.breakdown.skillMatch * 100);
      const pace = formatFixedMetric(r.breakdown.paceMatch * 100);
      const depth = formatFixedMetric(r.breakdown.depthMatch * 100);
      const density = formatFixedMetric(r.breakdown.densityMatch * 100);
      const schedule = formatFixedMetric(r.breakdown.scheduling * 100);
      const likelihood = formatFixedMetric(Number(pct));
      console.log(
        `  ${(index + 1).toString().padStart(3)}. likelihood:${likelihood}% score:${total} skill:${skill} pace:${pace} depth:${depth} density:${density} schedule:${schedule} | ${r.name}`,
      );
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(` Weight configuration used:`);
  for (const [key, val] of Object.entries(WEIGHTS)) {
    console.log(`   ${key.padEnd(20)} ${(val * 100).toFixed(0)}%`);
  }
  console.log(`═══════════════════════════════════════════════════════════════════\n`);
}

// ─── profile builder ─────────────────────────────────────────────────────────

function buildAllProfiles(
  events: EventRecord[],
  aliasResolver: AliasResolver,
): Map<string, PlayerProfile> {
  const map = new Map<string, PlayerProfile>();

  // Pre-pass: find max elimination round per event
  const maxRounds = new Map<number, number>();
  for (const ev of events) {
    let max = 0;
    for (const r of ev.results) {
      const rnd = parseRound(r.eliminationRound);
      if (rnd !== null && rnd > max) max = rnd;
    }
    // Winner has no eliminationRound; infer from runner-up
    maxRounds.set(ev.nr, max);
  }

  // Pre-pass: find winner's time per event for pace calculation
  const winnerTimes = new Map<number, number | null>();
  for (const ev of events) {
    const winner = ev.results.find((r) => r.placing === 1);
    winnerTimes.set(ev.nr, winner ? parseTime(winner.time) : null);
  }

  for (const ev of events) {
    const fieldSize = ev.results.length;
    const winnerTimeMs = winnerTimes.get(ev.nr) ?? null;

    for (const result of ev.results) {
      if (result.placing == null) continue;

      const canonical = resolveAlias(result.name, aliasResolver);

      if (!map.has(canonical)) {
        map.set(canonical, {
          canonicalName: canonical,
          races: [],
          racedEventNrs: new Set(),
          avgPercentile: 0,
          avgPaceScore: 0,
          avgEliminationDepth: 0,
        });
      }

      const profile = map.get(canonical)!;
      const elim = parseRound(result.eliminationRound);
      const maxRnd = maxRounds.get(ev.nr) ?? null;
      const myTime = parseTime(result.time);

      let paceScore: number | null = null;
      if (winnerTimeMs !== null && myTime !== null && winnerTimeMs > 0) {
        // Score 0-100: winner = 100, slowest reasonable = approaches 0
        // Use ratio: paceScore = 100 * winnerTime / myTime  (faster = higher)
        paceScore = Math.min(100, (winnerTimeMs / myTime) * 100);
      }

      profile.races.push({
        eventNr: ev.nr,
        eventLabel: ev.eventLabel,
        competitionType: ev.competitionType,
        placing: result.placing,
        fieldSize,
        placingPercentile: result.placing / fieldSize,
        paceScore,
        eliminationRound: elim,
        maxRound: maxRnd && maxRnd > 0 ? maxRnd : null,
      });
      profile.racedEventNrs.add(ev.nr);
    }
  }

  // Compute averages
  for (const profile of map.values()) {
    if (profile.races.length === 0) continue;

    profile.avgPercentile =
      profile.races.reduce((s, r) => s + r.placingPercentile, 0) / profile.races.length;

    const pacedRaces = profile.races.filter((r) => r.paceScore !== null);
    profile.avgPaceScore =
      pacedRaces.length > 0
        ? pacedRaces.reduce((s, r) => s + r.paceScore!, 0) / pacedRaces.length
        : 50;

    const depthedRaces = profile.races.filter((r) => r.eliminationRound !== null && r.maxRound !== null && r.maxRound > 0);
    profile.avgEliminationDepth =
      depthedRaces.length > 0
        ? depthedRaces.reduce((s, r) => s + r.eliminationRound! / r.maxRound!, 0) / depthedRaces.length
        : 0.5;
  }

  return map;
}

// ─── scorer ───────────────────────────────────────────────────────────────────

function scoreCandidate(
  mystery: PlayerProfile,
  suspect: PlayerProfile,
): { score: number; breakdown: Record<string, number>; disqualified: boolean } {
  // ── 1. Scheduling: hard disqualification if they share any event ──────────
  const overlap = [...mystery.racedEventNrs].filter((n) => suspect.racedEventNrs.has(n));
  if (overlap.length > 0) {
    return { score: 0, breakdown: { scheduling: 0, skillMatch: 0, paceMatch: 0, depthMatch: 0, densityMatch: 0 }, disqualified: true };
  }
  const schedulingScore = 1.0; // fully compatible

  // ── 2. Skill level match (placing percentile) ─────────────────────────────
  // Gaussian kernel: sigma = 0.15 (15 percentile points)
  const skillDiff = Math.abs(mystery.avgPercentile - suspect.avgPercentile);
  const skillScore = gaussian(skillDiff, 0.15);

  // ── 3. Pace score match ───────────────────────────────────────────────────
  // Gaussian kernel: sigma = 10 pace points
  const paceDiff = Math.abs(mystery.avgPaceScore - suspect.avgPaceScore);
  const paceScore = gaussian(paceDiff / 100, 0.10);

  // ── 4. Elimination depth match ────────────────────────────────────────────
  const depthDiff = Math.abs(mystery.avgEliminationDepth - suspect.avgEliminationDepth);
  const depthScore = gaussian(depthDiff, 0.15);

  // ── 5. Participation density match ───────────────────────────────────────
  // Compare races-per-available-event window
  const mysteryWindow = Math.max(...mystery.racedEventNrs) - Math.min(...mystery.racedEventNrs) + 1;
  const suspectWindow = Math.max(...suspect.racedEventNrs) - Math.min(...suspect.racedEventNrs) + 1;
  const mysteryDensity = mystery.races.length / Math.max(1, mysteryWindow);
  const suspectDensity = suspect.races.length / Math.max(1, suspectWindow);
  const densityRatio = Math.min(mysteryDensity, suspectDensity) / Math.max(mysteryDensity, suspectDensity);
  const densityScore = densityRatio; // 0-1; 1 = identical density

  const breakdown = {
    scheduling: schedulingScore,
    skillMatch: skillScore,
    paceMatch: paceScore,
    depthMatch: depthScore,
    densityMatch: densityScore,
  };

  const score =
    WEIGHTS.scheduling * schedulingScore +
    WEIGHTS.skillMatch * skillScore +
    WEIGHTS.paceMatch * paceScore +
    WEIGHTS.depthMatch * depthScore +
    WEIGHTS.densityMatch * densityScore;

  return { score, breakdown, disqualified: false };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Gaussian similarity kernel: returns 1 at diff=0, decays with sigma */
function gaussian(diff: number, sigma: number): number {
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}

function parseRound(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function parseTime(raw: string | null | undefined): number | null {
  if (!raw || raw === "DNF") return null;
  const cleaned = raw.trim();
  // "44.772" → milliseconds;  "1:36.431" → ms
  const colonIdx = cleaned.indexOf(":");
  if (colonIdx !== -1) {
    const minutes = parseFloat(cleaned.slice(0, colonIdx));
    const seconds = parseFloat(cleaned.slice(colonIdx + 1));
    return Math.round((minutes * 60 + seconds) * 1000);
  }
  const seconds = parseFloat(cleaned.replace(",", "."));
  return isNaN(seconds) ? null : Math.round(seconds * 1000);
}


function buildBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatFixedMetric(value: number): string {
  // Always one decimal place and left-pad with zeros for alignment, e.g. 005.0
  return value.toFixed(1).padStart(5, "0");
}

// ─── run ──────────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
