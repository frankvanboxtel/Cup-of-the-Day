import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { CompetitionType } from "./lib/event-data";
import { loadEventRecords } from "./lib/event-data";

type VideoMatchOverrides = {
    matches: Array<{
        videoId: string;
        eventType: CompetitionType;
        eventNumber: number;
    }>;
    excludedVideoIds: string[];
};

type ReviewQueueItem = {
    videoId: string;
    url: string;
    title: string;
    bestPotentialMatchesUnlocked: number;
    candidates: Array<{
        eventType: CompetitionType;
        eventNumber: number;
        score: number;
        potentialMatchesUnlocked: number;
    }>;
};

type VideoMatchIndex = {
    stats?: {
        videosScanned: number;
        accountedVideos: number;
        matchedVideos: number;
        manuallyExcludedVideos: number;
        unmatchedVideos: number;
        inferredFromGaps: number;
        anchorsUsed: number;
    };
    reviewQueue?: ReviewQueueItem[];
    matchesByEvent?: Array<{ videos: Array<{ videoId: string }> }>;
    ambiguousVideos?: Array<{ videoId: string }>;
    unmatchedVideos?: Array<{ videoId: string }>;
};

const projectRoot = path.resolve(__dirname, "..");
const overridesPath = path.join(projectRoot, "preferences", "video-match-overrides.json");
const cupDataDirectory = path.join(projectRoot, "data", "generated-jsons");
const matchIndexPath = path.join(
    projectRoot,
    "data",
    "generated-integrations",
    "cotd-video-matches.json",
);

async function main(): Promise<void> {
    const commandArguments = process.argv.slice(2);

    if (commandArguments[0] === "--") {
        commandArguments.shift();
    }

    const [command, videoValue, eventTypeValue, eventNumberValue] = commandArguments;

    if (command === "next") {
        regenerateMatches();
        await printProgress();
        await printNextReview();
        return;
    }

    if (command === "review") {
        await reviewInteractively();
        return;
    }

    if (!command || !videoValue || !["match", "exclude", "remove"].includes(command)) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    await saveDecision(command as "match" | "exclude" | "remove", videoValue, eventTypeValue, eventNumberValue);
    regenerateMatches();
    await printProgress();
    await printNextReview();
}

async function saveDecision(
    command: "match" | "exclude" | "remove",
    videoValue: string,
    eventTypeValue?: string,
    eventNumberValue?: string,
): Promise<void> {
    const videoId = parseVideoId(videoValue);
    const matchIndex = JSON.parse(
        await readFile(matchIndexPath, "utf8"),
    ) as VideoMatchIndex;

    if (command !== "remove" && !hasVideo(matchIndex, videoId)) {
        throw new Error(`Video ${videoId} is not present in the current scraper match index`);
    }

    const overrides = JSON.parse(
        await readFile(overridesPath, "utf8"),
    ) as VideoMatchOverrides;

    overrides.matches = overrides.matches.filter((match) => match.videoId !== videoId);
    overrides.excludedVideoIds = overrides.excludedVideoIds.filter((id) => id !== videoId);

    if (command === "match") {
        if (!isCompetitionType(eventTypeValue)) {
            throw new Error("Event type must be cotd, troll, or roulette");
        }

        const eventNumber = Number(eventNumberValue);

        if (!Number.isInteger(eventNumber) || eventNumber < 1) {
            throw new Error("Event number must be a positive integer");
        }

        const events = await loadEventRecords(cupDataDirectory);
        const eventExists = events.some(
            (event) => event.competitionType === eventTypeValue && event.nr === eventNumber,
        );

        if (!eventExists) {
            throw new Error(`Unknown event ${eventTypeValue}:${eventNumber}`);
        }

        overrides.matches.push({ videoId, eventType: eventTypeValue, eventNumber });
    } else if (command === "exclude") {
        overrides.excludedVideoIds.push(videoId);
    }

    overrides.matches.sort((left, right) => left.videoId.localeCompare(right.videoId));
    overrides.excludedVideoIds.sort();
    await writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");

    console.log(
        command === "remove"
            ? `Removed manual decision for ${videoId}.`
            : `Saved manual ${command} decision for ${videoId}.`,
    );
}

async function reviewInteractively(): Promise<void> {
    regenerateMatches();
    const prompts = createInterface({ input: stdin, output: stdout });
    const skippedVideoIds = new Set<string>();

    try {
        while (true) {
            const matchIndex = await loadMatchIndex();
            printProgressFromIndex(matchIndex);
            const next = matchIndex.reviewQueue?.find(
                (item) => !skippedVideoIds.has(item.videoId),
            );

            if (!next) {
                console.log("No more candidate-backed videos remain in this review session.");
                return;
            }

            printReviewItem(next);
            let answer: string;

            try {
                answer = (await prompts.question(
                    "Decision [event number, 'cotd 105', #suggestion, exclude, skip, quit]: ",
                )).trim().toLowerCase();
            } catch (error) {
                if (isReadlineClosedError(error)) {
                    return;
                }

                throw error;
            }

            if (answer === "quit" || answer === "q") {
                return;
            }

            if (answer === "skip" || answer === "s" || answer === "") {
                skippedVideoIds.add(next.videoId);
                continue;
            }

            if (answer === "exclude" || answer === "x") {
                await saveDecision("exclude", next.videoId);
                regenerateMatches();
                continue;
            }

            const suggestionMatch = answer.match(/^#(\d+)$/);
            const suggestionNumber = Number(suggestionMatch?.[1]);
            const selectedCandidate = Number.isInteger(suggestionNumber)
                ? next.candidates[suggestionNumber - 1]
                : null;
            const explicitMatch = answer.match(/^(cotd|troll|roulette)\s*[:#]?\s*(\d+)$/);
            const eventTypes = new Set(next.candidates.map((candidate) => candidate.eventType));
            const plainEventNumber = /^\d+$/.test(answer) ? Number(answer) : null;
            const inferredEventType = plainEventNumber !== null && eventTypes.size === 1
                ? next.candidates[0]?.eventType
                : null;
            const eventType = selectedCandidate?.eventType ?? explicitMatch?.[1] ?? inferredEventType;
            const eventNumber = selectedCandidate?.eventNumber ??
                Number(explicitMatch?.[2] ?? plainEventNumber);

            if (!isCompetitionType(eventType) || !Number.isInteger(eventNumber)) {
                console.log("Enter an event number, a match such as 'cotd 105', or a suggestion such as '#1'.");
                continue;
            }

            await saveDecision("match", next.videoId, eventType, String(eventNumber));
            regenerateMatches();
        }
    } finally {
        prompts.close();
    }
}

function regenerateMatches(): void {
    execFileSync(
        process.execPath,
        [
            path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
            path.join(projectRoot, "src", "generators", "generate-video-matches.ts"),
        ],
        { cwd: projectRoot, stdio: "inherit" },
    );
}

async function printNextReview(): Promise<void> {
    const matchIndex = await loadMatchIndex();
    const next = matchIndex.reviewQueue?.[0];

    if (!next) {
        console.log("No candidate-backed videos remain in the review queue.");
        return;
    }

    printReviewItem(next);
}

function printReviewItem(item: ReviewQueueItem): void {
    console.log(`\nNext review: ${item.title}`);
    console.log(item.url);
    console.log(`Best answer could account for ${item.bestPotentialMatchesUnlocked} videos:`);

    for (const [index, candidate] of item.candidates.entries()) {
        console.log(
            `  [#${index + 1}] ${candidate.eventType}:${candidate.eventNumber} | evidence ${candidate.score} | accounts for ${candidate.potentialMatchesUnlocked}`,
        );
    }
}

async function printProgress(): Promise<void> {
    printProgressFromIndex(await loadMatchIndex());
}

function printProgressFromIndex(matchIndex: VideoMatchIndex): void {
    const stats = matchIndex.stats;

    if (!stats) {
        return;
    }

    const percentage = stats.videosScanned > 0
        ? ((stats.accountedVideos / stats.videosScanned) * 100).toFixed(1)
        : "0.0";
    console.log(
        `Accounted for ${stats.accountedVideos}/${stats.videosScanned} videos (${percentage}%): ${stats.anchorsUsed} manual matches, ${stats.inferredFromGaps} exact streak matches, ${stats.manuallyExcludedVideos} excluded, ${stats.unmatchedVideos - stats.manuallyExcludedVideos} unknown.`,
    );
}

function isReadlineClosedError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_USE_AFTER_CLOSE"
    );
}

async function loadMatchIndex(): Promise<VideoMatchIndex> {
    return JSON.parse(await readFile(matchIndexPath, "utf8")) as VideoMatchIndex;
}

function hasVideo(matchIndex: VideoMatchIndex, videoId: string): boolean {
    return (
        matchIndex.matchesByEvent?.some((event) =>
            event.videos.some((video) => video.videoId === videoId),
        ) === true ||
        matchIndex.ambiguousVideos?.some((video) => video.videoId === videoId) === true ||
        matchIndex.unmatchedVideos?.some((video) => video.videoId === videoId) === true
    );
}

function parseVideoId(value: string): string {
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) {
        return value;
    }

    try {
        const url = new URL(value);
        const videoId = url.hostname === "youtu.be"
            ? url.pathname.split("/").filter(Boolean)[0]
            : url.searchParams.get("v");

        if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            return videoId;
        }
    } catch {
        // The validation error below covers non-URL input.
    }

    throw new Error(`Could not read a YouTube video ID from ${value}`);
}

function isCompetitionType(value: string | undefined): value is CompetitionType {
    return value === "cotd" || value === "troll" || value === "roulette";
}

function printUsage(): void {
    console.log(`Usage:
    pnpm run video-match -- review
  pnpm run video-match -- next
  pnpm run video-match -- match <video-id-or-url> <cotd|troll|roulette> <event-number>
  pnpm run video-match -- exclude <video-id-or-url>
  pnpm run video-match -- remove <video-id-or-url>`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});