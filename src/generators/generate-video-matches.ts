import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CompetitionType, EventRecord } from "../lib/event-data";
import { loadEventRecords } from "../lib/event-data";
import {
    loadAliasResolver,
    normalizeWhitespace,
    resolveAlias,
} from "../lib/player-names";

type EventSeriesType = CompetitionType;
type MatchConfidence = "high" | "medium" | "low";

type ScraperMetadata = {
    videoId: string;
    url: string;
    title: string;
    author: string;
    shortDescription: string;
    keywords: string[];
    uploadDate: string;
};

type ScraperMention = {
    player: string;
    videoId: string;
};

type PlaylistOrderFile = {
    discoveredAt: string;
    playlists: Array<{
        author: string;
        url: string;
        videos: Array<{
            videoId: string;
            url: string;
            position: number;
        }>;
    }>;
};

type TypeSignalStrength = "strong" | "weak" | "none";

type VideoTypeSignal = {
    inferredType: EventSeriesType | null;
    strength: TypeSignalStrength;
    reasons: string[];
};

type SeriesNumberHints = {
    cotd: number[];
    troll: number[];
    roulette: number[];
};

type VideoRecord = {
    videoId: string;
    url: string;
    title: string;
    channel: string;
    uploadDate: string;
    uploadTimestamp: number;
    searchableText: string;
    primaryText: string;
    typeSignal: VideoTypeSignal;
    numberHints: SeriesNumberHints;
};

type EventCandidate = {
    eventType: EventSeriesType;
    eventNumber: number;
    eventLabel: string;
    map: string;
    author: string;
    jsonFileName: string;
    htmlFileName: string;
    score: number;
    confidence: MatchConfidence;
    reasons: string[];
    matchedEventPlayers: Array<{ player: string; mentions: number }>;
};

type InitialDecision =
    | {
        videoId: string;
        outcome: "matched";
        match: EventCandidate;
        alternateCandidates: EventCandidate[];
    }
    | {
        videoId: string;
        outcome: "ambiguous";
        candidates: EventCandidate[];
        reason: string;
    }
    | {
        videoId: string;
        outcome: "unmatched";
        reason: string;
    };

type Anchor = {
    videoId: string;
    timelineIndex: number;
    eventType: EventSeriesType;
    eventNumber: number;
};

type GapInference = {
    videoId: string;
    inferredType: EventSeriesType;
    inferredNumber: number;
    fromAnchor: { videoId: string; eventNumber: number };
    toAnchor: { videoId: string; eventNumber: number };
};

type VideoMatchOverrides = {
    matches: Array<{
        videoId: string;
        eventType: EventSeriesType;
        eventNumber: number;
    }>;
    excludedVideoIds: string[];
};

type FinalMatchedVideo = {
    videoId: string;
    url: string;
    title: string;
    channel: string;
    uploadDate: string;
    timelineIndex: number;
    score: number;
    confidence: MatchConfidence;
    reasons: string[];
    matchedEventPlayers: Array<{ player: string; mentions: number }>;
    inferredFromGap: boolean;
};

type EventMatchOutput = {
    eventType: EventSeriesType;
    eventNumber: number;
    eventLabel: string;
    map: string;
    author: string;
    jsonFileName: string;
    htmlFileName: string;
    videos: FinalMatchedVideo[];
};

type AmbiguousVideo = {
    videoId: string;
    url: string;
    title: string;
    uploadDate: string;
    timelineIndex: number;
    typeSignal: VideoTypeSignal;
    numberHints: SeriesNumberHints;
    candidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        score: number;
        confidence: MatchConfidence;
        reasons: string[];
    }>;
    reason: string;
};

type UnmatchedVideo = {
    videoId: string;
    url: string;
    title: string;
    uploadDate: string;
    timelineIndex: number;
    typeSignal: VideoTypeSignal;
    numberHints: SeriesNumberHints;
    reason: string;
};

type ReviewQueueItem = {
    videoId: string;
    url: string;
    title: string;
    currentOutcome: "ambiguous" | "unmatched";
    bestPotentialMatchesUnlocked: number;
    candidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        score: number;
        potentialMatchesUnlocked: number;
    }>;
};

type MentionIndex = Map<string, Map<string, number>>;

type VideoMatchIndex = {
    generatedAt: string;
    sources: {
        cupDataDirectory: string;
        scraperOutputDirectory: string;
        videosDirectory: string;
        mentionsIndexFile: string | null;
        playlistOrderFile: string | null;
        overridesFile: string;
    };
    strategy: {
        summary: string;
        steps: string[];
    };
    stats: {
        videosScanned: number;
        accountedVideos: number;
        matchedVideos: number;
        manuallyExcludedVideos: number;
        ambiguousVideos: number;
        unmatchedVideos: number;
        highConfidenceMatches: number;
        mediumConfidenceMatches: number;
        lowConfidenceMatches: number;
        inferredFromGaps: number;
        anchorsUsed: number;
    };
    gapInferences: GapInference[];
    reviewQueue: ReviewQueueItem[];
    matchesByEvent: EventMatchOutput[];
    ambiguousVideos: AmbiguousVideo[];
    unmatchedVideos: UnmatchedVideo[];
};

const projectRoot = path.resolve(__dirname, "../..");
const cupDataDirectory = path.join(projectRoot, "data", "generated-jsons");
const outputDirectory = path.join(projectRoot, "data", "generated-integrations");
const outputPath = path.join(outputDirectory, "cotd-video-matches.json");
const overridesPath = path.join(
    projectRoot,
    "preferences",
    "video-match-overrides.json",
);
const manualAliasListPath = path.join(
    projectRoot,
    "preferences",
    "player-aliases.json",
);
const generatedAliasListPath = path.join(
    projectRoot,
    "preferences",
    "player-aliases.generated.json",
);
const defaultScraperOutputDirectory = path.resolve(
    projectRoot,
    "..",
    "zcotd scraper",
    "output",
);

const commonWordFilter = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "over",
    "under",
    "about",
    "zeepkist",
    "cup",
    "day",
    "week",
    "map",
    "round",
    "final",
    "video",
]);

async function main(): Promise<void> {
    const scraperOutputDirectory = getScraperOutputDirectory();
    const videosDirectory = path.join(scraperOutputDirectory, "videos");
    const aliasResolver = await loadAliasResolver(
        manualAliasListPath,
        generatedAliasListPath,
    );

    const baseOutput = buildEmptyOutput(scraperOutputDirectory, videosDirectory);

    if (!(await exists(videosDirectory))) {
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(baseOutput, null, 2)}\n`, "utf8");
        console.log(
            `No scraper videos directory found at ${videosDirectory}. Generated empty file at ${path.relative(projectRoot, outputPath)}.`,
        );
        return;
    }

    const eventRecords = await loadEventRecords(cupDataDirectory);
    const eventCandidates = eventRecords.map((eventRecord) => ({
        eventType: eventRecord.competitionType,
        eventNumber: eventRecord.nr,
        eventLabel: eventRecord.eventLabel,
        map: eventRecord.map,
        author: eventRecord.author,
        jsonFileName: eventRecord.jsonFileName,
        htmlFileName: eventRecord.htmlFileName,
        eventRecord,
    }));

    const playlistOrder = await loadPlaylistOrder(scraperOutputDirectory);
    baseOutput.sources.playlistOrderFile = playlistOrder.sourceFile;
    const videos = await loadVideoRecords(videosDirectory, playlistOrder.data);
    const mentionsIndex = await loadMentionsIndex(scraperOutputDirectory, aliasResolver);
    baseOutput.sources.mentionsIndexFile = mentionsIndex.sourceFile;
    const overrides = await loadVideoMatchOverrides();

    const candidatesByVideo = new Map<string, EventCandidate[]>();
    const initialDecisions: InitialDecision[] = videos.map((videoRecord) => {
        const candidates = scoreCandidates(
            videoRecord,
            eventCandidates,
            mentionsIndex.byVideo,
            aliasResolver,
        );
        candidatesByVideo.set(videoRecord.videoId, candidates);
        return {
            videoId: videoRecord.videoId,
            outcome: "unmatched",
            reason: "No manual match or exact anchored playlist streak",
        };
    });

    const manualDecisions = applyManualOverrides(
        initialDecisions,
        overrides,
        videos,
        eventCandidates,
    );
    const chronologySequences = buildChronologySequences(videos, playlistOrder.data);
    const resolution = resolveDecisions(
        videos,
        manualDecisions,
        chronologySequences,
        eventCandidates,
    );
    const appliedGapInferences = resolution.gapInferences.filter((inference) => {
        const decision = resolution.finalDecisions.find(
            (candidate) => candidate.videoId === inference.videoId,
        );

        return (
            decision?.outcome === "matched" &&
            decision.match.eventType === inference.inferredType &&
            decision.match.eventNumber === inference.inferredNumber &&
            decision.match.reasons.some((reason) =>
                reason.includes("chronology gap-fill"),
            )
        );
    });

    const matchesByEvent = buildMatchesByEvent(videos, resolution.finalDecisions);
    const ambiguousVideos = buildAmbiguousVideos(videos, resolution.finalDecisions);
    const unmatchedVideos = buildUnmatchedVideos(videos, resolution.finalDecisions);
    const reviewQueue = buildReviewQueue(
        videos,
        resolution.finalDecisions,
        manualDecisions,
        candidatesByVideo,
        chronologySequences,
        eventCandidates,
    );

    const stats = buildStats(matchesByEvent, ambiguousVideos, unmatchedVideos, appliedGapInferences, resolution.anchors.length, videos.length);

    const output: VideoMatchIndex = {
        ...baseOutput,
        stats,
        gapInferences: appliedGapInferences,
        reviewQueue,
        matchesByEvent,
        ambiguousVideos,
        unmatchedVideos,
    };

    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    console.log(
        [
            `Generated ${path.relative(projectRoot, outputPath)}.`,
            `Videos: ${stats.videosScanned}`,
            `Accounted: ${stats.accountedVideos}`,
            `Matched: ${stats.matchedVideos}`,
            `Excluded: ${stats.manuallyExcludedVideos}`,
            `Ambiguous: ${stats.ambiguousVideos}`,
            `Unmatched: ${stats.unmatchedVideos}`,
            `Gap inferred: ${stats.inferredFromGaps}`,
            `Next review gain: ${reviewQueue[0]?.bestPotentialMatchesUnlocked ?? 0}`,
        ].join(" "),
    );
}

function buildEmptyOutput(
    scraperOutputDirectory: string,
    videosDirectory: string,
): VideoMatchIndex {
    return {
        generatedAt: new Date().toISOString(),
        sources: {
            cupDataDirectory: path.relative(projectRoot, cupDataDirectory),
            scraperOutputDirectory,
            videosDirectory,
            mentionsIndexFile: null,
            playlistOrderFile: null,
            overridesFile: path.relative(projectRoot, overridesPath),
        },
        strategy: {
            summary:
                "Manual matches plus exact playlist streak inference strictly between manual anchors.",
            steps: [
                "Orient playlists by upload date and merge overlapping playlist order constraints",
                "Use only manual matches as trusted anchors and keep manually excluded videos unmatched",
                "For two manual anchors of the same event type, fill the videos between them only when their count exactly matches the missing event numbers",
                "Leave videos before the first anchor, after the last anchor, and non-exact intervals unknown",
                "Use text scoring only to suggest candidates for manual review",
            ],
        },
        stats: {
            videosScanned: 0,
            accountedVideos: 0,
            matchedVideos: 0,
            manuallyExcludedVideos: 0,
            ambiguousVideos: 0,
            unmatchedVideos: 0,
            highConfidenceMatches: 0,
            mediumConfidenceMatches: 0,
            lowConfidenceMatches: 0,
            inferredFromGaps: 0,
            anchorsUsed: 0,
        },
        gapInferences: [],
        reviewQueue: [],
        matchesByEvent: [],
        ambiguousVideos: [],
        unmatchedVideos: [],
    };
}

function resolveDecisions(
    videos: VideoRecord[],
    seedDecisions: InitialDecision[],
    chronologySequences: VideoRecord[][],
    eventCandidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        eventLabel: string;
        map: string;
        author: string;
        jsonFileName: string;
        htmlFileName: string;
    }>,
): {
    anchors: Anchor[];
    gapInferences: GapInference[];
    finalDecisions: InitialDecision[];
} {
    const anchors = buildAnchors(seedDecisions, videos);
    const gapInferences = inferGaps(chronologySequences, anchors, seedDecisions);

    return {
        anchors,
        gapInferences,
        finalDecisions: applyGapInferences(seedDecisions, gapInferences, eventCandidates),
    };
}

function buildReviewQueue(
    videos: VideoRecord[],
    finalDecisions: InitialDecision[],
    seedDecisions: InitialDecision[],
    candidatesByVideo: Map<string, EventCandidate[]>,
    chronologySequences: VideoRecord[][],
    eventCandidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        eventLabel: string;
        map: string;
        author: string;
        jsonFileName: string;
        htmlFileName: string;
    }>,
): ReviewQueueItem[] {
    const finalByVideo = new Map(finalDecisions.map((decision) => [decision.videoId, decision]));
    const baselineMatched = finalDecisions.filter((decision) => decision.outcome === "matched").length;

    return videos
        .flatMap((video) => {
            const finalDecision = finalByVideo.get(video.videoId);

            if (
                !finalDecision ||
                finalDecision.outcome === "matched" ||
                (finalDecision.outcome === "unmatched" &&
                    finalDecision.reason === "Excluded by manual override")
            ) {
                return [];
            }

            const candidates = (candidatesByVideo.get(video.videoId) ?? [])
                .slice(0, 4)
                .map((candidate) => {
                    const simulatedSeed = seedDecisions.map((decision) =>
                        decision.videoId === video.videoId
                            ? {
                                videoId: video.videoId,
                                outcome: "matched" as const,
                                match: {
                                    ...candidate,
                                    score: 100,
                                    confidence: "high" as const,
                                    reasons: ["Confirmed by manual override"],
                                    matchedEventPlayers: [],
                                },
                                alternateCandidates: [],
                            }
                            : decision,
                    );
                    const simulated = resolveDecisions(
                        videos,
                        simulatedSeed,
                        chronologySequences,
                        eventCandidates,
                    );
                    const simulatedMatched = simulated.finalDecisions.filter(
                        (decision) => decision.outcome === "matched",
                    ).length;

                    return {
                        eventType: candidate.eventType,
                        eventNumber: candidate.eventNumber,
                        score: candidate.score,
                        potentialMatchesUnlocked: Math.max(1, simulatedMatched - baselineMatched),
                    };
                });

            if (candidates.length === 0) {
                return [];
            }

            candidates.sort(
                (left, right) =>
                    right.potentialMatchesUnlocked - left.potentialMatchesUnlocked ||
                    right.score - left.score,
            );

            return [{
                videoId: video.videoId,
                url: video.url,
                title: video.title,
                currentOutcome: finalDecision.outcome,
                bestPotentialMatchesUnlocked: candidates[0]?.potentialMatchesUnlocked ?? 1,
                candidates,
            } satisfies ReviewQueueItem];
        })
        .sort(
            (left, right) => {
                const outcomeOrder = left.currentOutcome === right.currentOutcome
                    ? 0
                    : left.currentOutcome === "ambiguous"
                        ? -1
                        : 1;

                return (
                    right.bestPotentialMatchesUnlocked - left.bestPotentialMatchesUnlocked ||
                    outcomeOrder ||
                    left.title.localeCompare(right.title)
                );
            },
        )
        .slice(0, 25);
}

async function loadVideoMatchOverrides(): Promise<VideoMatchOverrides> {
    if (!(await exists(overridesPath))) {
        return { matches: [], excludedVideoIds: [] };
    }

    const parsed = JSON.parse(await readFile(overridesPath, "utf8")) as Partial<VideoMatchOverrides>;

    return {
        matches: parsed.matches ?? [],
        excludedVideoIds: parsed.excludedVideoIds ?? [],
    };
}

function applyManualOverrides(
    decisions: InitialDecision[],
    overrides: VideoMatchOverrides,
    videos: VideoRecord[],
    eventCandidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        eventLabel: string;
        map: string;
        author: string;
        jsonFileName: string;
        htmlFileName: string;
    }>,
): InitialDecision[] {
    const videoIds = new Set(videos.map((video) => video.videoId));
    const decisionsByVideo = new Map(decisions.map((decision) => [decision.videoId, decision]));
    const eventsByKey = new Map(
        eventCandidates.map((event) => [`${event.eventType}:${event.eventNumber}`, event]),
    );
    const excludedVideoIds = new Set(overrides.excludedVideoIds);
    const manuallyMatchedVideoIds = new Set<string>();

    for (const override of overrides.matches) {
        if (!videoIds.has(override.videoId)) {
            throw new Error(`Manual override references unknown video ${override.videoId}`);
        }

        if (manuallyMatchedVideoIds.has(override.videoId)) {
            throw new Error(`Manual override contains multiple matches for video ${override.videoId}`);
        }

        if (excludedVideoIds.has(override.videoId)) {
            throw new Error(`Video ${override.videoId} is both matched and excluded manually`);
        }

        const event = eventsByKey.get(`${override.eventType}:${override.eventNumber}`);

        if (!event) {
            throw new Error(
                `Manual override references unknown event ${override.eventType}:${override.eventNumber}`,
            );
        }

        manuallyMatchedVideoIds.add(override.videoId);
        decisionsByVideo.set(override.videoId, {
            videoId: override.videoId,
            outcome: "matched",
            match: {
                ...event,
                score: 100,
                confidence: "high",
                reasons: ["Confirmed by manual override"],
                matchedEventPlayers: [],
            },
            alternateCandidates: [],
        });
    }

    for (const videoId of excludedVideoIds) {
        if (!videoIds.has(videoId)) {
            throw new Error(`Manual exclusion references unknown video ${videoId}`);
        }

        decisionsByVideo.set(videoId, {
            videoId,
            outcome: "unmatched",
            reason: "Excluded by manual override",
        });
    }

    return decisions.map((decision) => decisionsByVideo.get(decision.videoId) ?? decision);
}

function buildStats(
    matchesByEvent: EventMatchOutput[],
    ambiguousVideos: AmbiguousVideo[],
    unmatchedVideos: UnmatchedVideo[],
    gapInferences: GapInference[],
    anchorsUsed: number,
    videosScanned: number,
): VideoMatchIndex["stats"] {
    const allMatches = matchesByEvent.flatMap((eventMatch) => eventMatch.videos);
    const manuallyExcludedVideos = unmatchedVideos.filter(
        (video) => video.reason === "Excluded by manual override",
    ).length;

    return {
        videosScanned,
        accountedVideos: allMatches.length + manuallyExcludedVideos,
        matchedVideos: allMatches.length,
        manuallyExcludedVideos,
        ambiguousVideos: ambiguousVideos.length,
        unmatchedVideos: unmatchedVideos.length,
        highConfidenceMatches: allMatches.filter((match) => match.confidence === "high").length,
        mediumConfidenceMatches: allMatches.filter((match) => match.confidence === "medium").length,
        lowConfidenceMatches: allMatches.filter((match) => match.confidence === "low").length,
        inferredFromGaps: gapInferences.length,
        anchorsUsed,
    };
}

function getScraperOutputDirectory(): string {
    const cliArg = process.argv
        .slice(2)
        .find((arg) => arg.startsWith("--scraper-output="));

    if (cliArg) {
        return path.resolve(projectRoot, cliArg.slice("--scraper-output=".length));
    }

    const envPath = process.env.ZCOTD_SCRAPER_OUTPUT_DIR;

    if (envPath) {
        return path.resolve(envPath);
    }

    return defaultScraperOutputDirectory;
}

async function loadVideoRecords(
    videosDirectory: string,
    playlistOrder: PlaylistOrderFile | null,
): Promise<VideoRecord[]> {
    const videoIds = (await readdir(videosDirectory)).sort((left, right) =>
        left.localeCompare(right),
    );

    const records: VideoRecord[] = [];

    for (const videoId of videoIds) {
        const metadataPath = path.join(videosDirectory, videoId, "metadata.json");

        if (!(await exists(metadataPath))) {
            continue;
        }

        try {
            const metadata = JSON.parse(
                await readFile(metadataPath, "utf8"),
            ) as ScraperMetadata;

            const searchableText = normalizeText([
                metadata.title,
                metadata.shortDescription,
                metadata.keywords.join(" "),
            ].join(" "));
            const primaryText = normalizeText([
                metadata.title,
                metadata.shortDescription.split(/\n\s*\n/)[0] ?? "",
            ].join(" "));

            const typeSignal = inferSeriesType(searchableText);
            const numberHints = extractSeriesNumberHints(searchableText, typeSignal);
            const uploadTimestamp = Date.parse(metadata.uploadDate || "");

            records.push({
                videoId,
                url: metadata.url,
                title: metadata.title,
                channel: metadata.author,
                uploadDate: metadata.uploadDate,
                uploadTimestamp: Number.isFinite(uploadTimestamp)
                    ? uploadTimestamp
                    : Number.MAX_SAFE_INTEGER,
                searchableText,
                primaryText,
                typeSignal,
                numberHints,
            });
        } catch {
            continue;
        }
    }

    return sortVideosByChronology(records, playlistOrder);
}

async function loadPlaylistOrder(
    scraperOutputDirectory: string,
): Promise<{ data: PlaylistOrderFile | null; sourceFile: string | null }> {
    const filePath = path.join(scraperOutputDirectory, "playlist-order.json");

    if (!(await exists(filePath))) {
        return { data: null, sourceFile: null };
    }

    try {
        return {
            data: JSON.parse(await readFile(filePath, "utf8")) as PlaylistOrderFile,
            sourceFile: filePath,
        };
    } catch {
        return { data: null, sourceFile: null };
    }
}

function sortVideosByChronology(
    videos: VideoRecord[],
    playlistOrder: PlaylistOrderFile | null,
): VideoRecord[] {
    const fallbackOrder = [...videos].sort(compareVideoDates);

    if (!playlistOrder || playlistOrder.playlists.length === 0) {
        return fallbackOrder;
    }

    const videoById = new Map(videos.map((video) => [video.videoId, video]));
    const edges = new Map<string, Set<string>>();
    const indegree = new Map(videos.map((video) => [video.videoId, 0]));

    for (const playlist of playlistOrder.playlists) {
        const playlistVideos = playlist.videos
            .sort((left, right) => left.position - right.position)
            .map((entry) => videoById.get(entry.videoId))
            .filter((video): video is VideoRecord => Boolean(video));

        if (playlistVideos.length < 2) {
            continue;
        }

        const firstTimestamp = playlistVideos[0]?.uploadTimestamp ?? 0;
        const lastTimestamp = playlistVideos.at(-1)?.uploadTimestamp ?? 0;
        const chronological =
            firstTimestamp <= lastTimestamp
                ? playlistVideos
                : [...playlistVideos].reverse();

        for (let index = 0; index < chronological.length - 1; index += 1) {
            const left = chronological[index];
            const right = chronological[index + 1];

            if (!left || !right || left.videoId === right.videoId) {
                continue;
            }

            const outgoing = edges.get(left.videoId) ?? new Set<string>();

            if (!outgoing.has(right.videoId)) {
                outgoing.add(right.videoId);
                edges.set(left.videoId, outgoing);
                indegree.set(right.videoId, (indegree.get(right.videoId) ?? 0) + 1);
            }
        }
    }

    const remaining = new Set(videos.map((video) => video.videoId));
    const ordered: VideoRecord[] = [];

    while (remaining.size > 0) {
        const available = Array.from(remaining)
            .filter((videoId) => (indegree.get(videoId) ?? 0) === 0)
            .map((videoId) => videoById.get(videoId))
            .filter((video): video is VideoRecord => Boolean(video))
            .sort(compareVideoDates);

        const next = available[0];

        if (!next) {
            return fallbackOrder;
        }

        ordered.push(next);
        remaining.delete(next.videoId);

        for (const targetVideoId of edges.get(next.videoId) ?? []) {
            indegree.set(targetVideoId, (indegree.get(targetVideoId) ?? 0) - 1);
        }
    }

    return ordered;
}

function compareVideoDates(left: VideoRecord, right: VideoRecord): number {
    return (
        left.uploadTimestamp - right.uploadTimestamp ||
        left.videoId.localeCompare(right.videoId)
    );
}

async function loadMentionsIndex(
    scraperOutputDirectory: string,
    aliasResolver: Awaited<ReturnType<typeof loadAliasResolver>>,
): Promise<{ byVideo: MentionIndex; sourceFile: string | null }> {
    const preferredFiles = [
        path.join(scraperOutputDirectory, "mentions-index-post-processed.json"),
        path.join(scraperOutputDirectory, "mentions-index.json"),
    ];

    for (const filePath of preferredFiles) {
        if (!(await exists(filePath))) {
            continue;
        }

        try {
            const parsed = JSON.parse(await readFile(filePath, "utf8")) as ScraperMention[];
            const byVideo = new Map<string, Map<string, number>>();

            for (const mention of parsed) {
                const canonical = resolveAlias(mention.player, aliasResolver);
                const videoMentions = byVideo.get(mention.videoId) ?? new Map<string, number>();
                videoMentions.set(canonical, (videoMentions.get(canonical) ?? 0) + 1);
                byVideo.set(mention.videoId, videoMentions);
            }

            return {
                byVideo,
                sourceFile: filePath,
            };
        } catch {
            continue;
        }
    }

    return {
        byVideo: new Map(),
        sourceFile: null,
    };
}

function inferSeriesType(searchableText: string): VideoTypeSignal {
    const reasons: string[] = [];
    const typeText = searchableText.replace(/\bnon-troll\b/g, " ");
    const hasCupContext =
        typeText.includes("cup of the day") ||
        typeText.includes("cup of the week") ||
        typeText.includes("cotd") ||
        typeText.includes("cotw");
    const hasTroll = hasCupContext && /\btroll\b/.test(typeText);
    const hasRoulette = typeText.includes("roulette") || typeText.includes("cup of the roulette");
    const hasRegular =
        typeText.includes("cup of the day") ||
        typeText.includes("cup of the week") ||
        typeText.includes(" cotd") ||
        typeText.includes(" cotw");

    if (hasTroll) {
        reasons.push("Video text contains troll marker");
        return { inferredType: "troll", strength: "strong", reasons };
    }

    if (hasRoulette && !hasTroll) {
        reasons.push("Video text contains roulette marker");
        return { inferredType: "roulette", strength: "strong", reasons };
    }

    if (hasRegular) {
        reasons.push("Video text contains cup marker without troll/roulette markers");
        return { inferredType: "cotd", strength: "weak", reasons };
    }

    return { inferredType: null, strength: "none", reasons: ["No type marker in video text"] };
}

function extractSeriesNumberHints(
    searchableText: string,
    typeSignal: VideoTypeSignal,
): SeriesNumberHints {
    const hints: SeriesNumberHints = {
        cotd: [],
        troll: [],
        roulette: [],
    };

    const add = (type: EventSeriesType, nr: number): void => {
        if (nr > 0 && nr < 5000 && !hints[type].includes(nr)) {
            hints[type].push(nr);
        }
    };

    for (const match of searchableText.matchAll(/\btroll\s+cot[dw]\s*#?\s*(\d{1,4})\b/g)) {
        add("troll", Number(match[1]));
    }

    for (const match of searchableText.matchAll(/\btroll\s+cup\s+of\s+the\s+day\s*#?\s*(\d{1,4})\b/g)) {
        add("troll", Number(match[1]));
    }

    for (const match of searchableText.matchAll(/\btroll\s+cup\s*#?\s*(\d{1,4})\b/g)) {
        add("troll", Number(match[1]));
    }

    for (const match of searchableText.matchAll(/\b(?:cup\s+of\s+the\s+day\s+)?roulette\s*#?\s*(\d{1,4})\b/g)) {
        add("roulette", Number(match[1]));
    }

    for (const match of searchableText.matchAll(/\bcot[dw]\s*#?\s*(\d{1,4})\b/g)) {
        const nr = Number(match[1]);

        if (typeSignal.inferredType === "troll") {
            add("troll", nr);
        } else if (typeSignal.inferredType === "roulette") {
            add("roulette", nr);
        } else {
            add("cotd", nr);
        }
    }

    for (const key of Object.keys(hints) as EventSeriesType[]) {
        hints[key].sort((left, right) => left - right);
    }

    return hints;
}

function scoreCandidates(
    video: VideoRecord,
    eventCandidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        eventLabel: string;
        map: string;
        author: string;
        jsonFileName: string;
        htmlFileName: string;
        eventRecord: EventRecord;
    }>,
    mentionsByVideo: MentionIndex,
    aliasResolver: Awaited<ReturnType<typeof loadAliasResolver>>,
): EventCandidate[] {
    const mentionCounts = mentionsByVideo.get(video.videoId) ?? new Map<string, number>();
    const videoTokens = new Set(video.searchableText.split(" ").filter(Boolean));

    return eventCandidates
        .map((eventCandidate) => {
            const reasons: string[] = [];
            let score = 0;

            if (video.typeSignal.inferredType !== null) {
                if (video.typeSignal.inferredType === eventCandidate.eventType) {
                    score += video.typeSignal.strength === "strong" ? 40 : 18;
                    reasons.push("Video series type matches candidate event type");
                } else if (video.typeSignal.strength === "strong") {
                    score -= 35;
                    reasons.push("Video series type conflicts with candidate event type");
                }
            }

            const hintedNumbers = video.numberHints[eventCandidate.eventType];

            if (hintedNumbers.length > 0) {
                if (hintedNumbers.includes(eventCandidate.eventNumber)) {
                    score += 80;
                    reasons.push(
                        `Video text explicitly references ${eventCandidate.eventType.toUpperCase()} ${eventCandidate.eventNumber}`,
                    );
                } else {
                    score -= 18;
                    reasons.push("Video has explicit number hint for this series but not this event number");
                }
            }

            const normalizedMap = normalizeMapLabel(eventCandidate.map);

            if (normalizedMap.length > 8 && video.searchableText.includes(normalizedMap)) {
                score += 28;
                reasons.push("Map title appears directly in video text");
            } else {
                const mapTokenOverlap = countTokenOverlap(buildKeywords(normalizedMap), videoTokens);

                if (mapTokenOverlap >= 2) {
                    const bonus = Math.min(18, mapTokenOverlap * 5);
                    score += bonus;
                    reasons.push(`Map keyword overlap (${mapTokenOverlap} tokens)`);
                }
            }

            const eventAuthors = splitAuthorNames(eventCandidate.author);
            const strongAuthorOverlap = eventAuthors.filter((authorName) =>
                hasStrongMapperEvidence(video.primaryText, authorName),
            );
            const weakAuthorOverlap = eventAuthors.filter(
                (authorName) =>
                    !strongAuthorOverlap.includes(authorName) &&
                    authorName.length > 2 &&
                    video.primaryText.includes(authorName),
            );

            if (strongAuthorOverlap.length > 0) {
                score += Math.min(24, strongAuthorOverlap.length * 16);
                reasons.push(`Strong mapper evidence: ${strongAuthorOverlap.join(", ")}`);
            } else if (weakAuthorOverlap.length > 0) {
                score += Math.min(6, weakAuthorOverlap.length * 3);
                reasons.push(
                    `Mapper name appears in primary video text: ${weakAuthorOverlap.join(", ")}`,
                );
            }

            const eventTopPlayers = eventCandidate.eventRecord.results
                .slice(0, 12)
                .map((result) => resolveAlias(result.name, aliasResolver));
            const uniqueEventTopPlayers = Array.from(new Set(eventTopPlayers));

            const matchedEventPlayers = uniqueEventTopPlayers
                .map((player) => ({
                    player,
                    mentions: mentionCounts.get(player) ?? 0,
                }))
                .filter((entry) => entry.mentions > 0)
                .sort((left, right) => right.mentions - left.mentions || left.player.localeCompare(right.player));

            if (matchedEventPlayers.length > 0) {
                const mentionScore = Math.min(
                    18,
                    matchedEventPlayers.length * 2 +
                    matchedEventPlayers.reduce((sum, entry) => sum + Math.min(2, entry.mentions), 0),
                );
                score += mentionScore;
                reasons.push(
                    `Transcript mentions ${matchedEventPlayers.length} top event players`,
                );
            }

            const confidence = classifyConfidence(score);

            return {
                eventType: eventCandidate.eventType,
                eventNumber: eventCandidate.eventNumber,
                eventLabel: eventCandidate.eventLabel,
                map: eventCandidate.map,
                author: eventCandidate.author,
                jsonFileName: eventCandidate.jsonFileName,
                htmlFileName: eventCandidate.htmlFileName,
                score,
                confidence,
                reasons,
                matchedEventPlayers,
            } satisfies EventCandidate;
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.eventNumber - right.eventNumber);
}

function buildAnchors(initialDecisions: InitialDecision[], videos: VideoRecord[]): Anchor[] {
    const timelineIndexByVideo = new Map(videos.map((video, index) => [video.videoId, index]));

    return initialDecisions
        .filter(
            (decision): decision is Extract<InitialDecision, { outcome: "matched" }> =>
                decision.outcome === "matched",
        )
        .filter((decision) =>
            decision.match.reasons.includes("Confirmed by manual override"),
        )
        .map((decision) => ({
            videoId: decision.videoId,
            timelineIndex: timelineIndexByVideo.get(decision.videoId) ?? Number.MAX_SAFE_INTEGER,
            eventType: decision.match.eventType,
            eventNumber: decision.match.eventNumber,
        }))
        .sort(
            (left, right) =>
                left.timelineIndex - right.timelineIndex ||
                left.eventNumber - right.eventNumber,
        );
}

function inferGaps(
    chronologySequences: VideoRecord[][],
    anchors: Anchor[],
    initialDecisions: InitialDecision[],
): GapInference[] {
    const decisionsByVideo = new Map(initialDecisions.map((decision) => [decision.videoId, decision]));
    const proposals = new Map<string, GapInference[]>();
    const anchorByVideoId = new Map(anchors.map((anchor) => [anchor.videoId, anchor]));

    for (const videos of chronologySequences) {
        const sequenceIndexByVideo = new Map(
            videos.map((video, index) => [video.videoId, index]),
        );

        for (const eventType of ["cotd", "troll", "roulette"] as const) {
            const typedAnchors = videos
                .flatMap((video) => {
                    const anchor = anchorByVideoId.get(video.videoId);
                    return anchor?.eventType === eventType ? [anchor] : [];
                })
                .sort(
                    (left, right) =>
                        (sequenceIndexByVideo.get(left.videoId) ?? Number.MAX_SAFE_INTEGER) -
                        (sequenceIndexByVideo.get(right.videoId) ?? Number.MAX_SAFE_INTEGER),
                );

            for (let i = 0; i < typedAnchors.length - 1; i += 1) {
                const leftAnchor = typedAnchors[i];
                const rightAnchor = typedAnchors[i + 1];

                if (!leftAnchor || !rightAnchor) {
                    continue;
                }

                if (rightAnchor.eventNumber <= leftAnchor.eventNumber) {
                    continue;
                }

                const expectedBetween = rightAnchor.eventNumber - leftAnchor.eventNumber - 1;

                if (expectedBetween <= 0) {
                    continue;
                }

                const leftIndex = sequenceIndexByVideo.get(leftAnchor.videoId);
                const rightIndex = sequenceIndexByVideo.get(rightAnchor.videoId);

                if (leftIndex === undefined || rightIndex === undefined) {
                    continue;
                }

                const candidateVideosBetween = videos
                    .slice(leftIndex + 1, rightIndex)
                    .filter((video) => isGapCandidate(video, eventType, decisionsByVideo));

                if (candidateVideosBetween.length !== expectedBetween) {
                    continue;
                }

                for (let offset = 0; offset < candidateVideosBetween.length; offset += 1) {
                    const video = candidateVideosBetween[offset];

                    if (!video) {
                        continue;
                    }

                    const inference: GapInference = {
                        videoId: video.videoId,
                        inferredType: eventType,
                        inferredNumber: leftAnchor.eventNumber + offset + 1,
                        fromAnchor: {
                            videoId: leftAnchor.videoId,
                            eventNumber: leftAnchor.eventNumber,
                        },
                        toAnchor: {
                            videoId: rightAnchor.videoId,
                            eventNumber: rightAnchor.eventNumber,
                        },
                    };

                    const videoProposals = proposals.get(video.videoId) ?? [];
                    videoProposals.push(inference);
                    proposals.set(video.videoId, videoProposals);
                }
            }
        }
    }

    return Array.from(proposals.values()).flatMap((videoProposals) => {
        const first = videoProposals[0];

        if (!first) {
            return [];
        }

        const agrees = videoProposals.every(
            (proposal) =>
                proposal.inferredType === first.inferredType &&
                proposal.inferredNumber === first.inferredNumber,
        );

        return agrees ? [first] : [];
    });
}

function isGapCandidate(
    video: VideoRecord,
    eventType: EventSeriesType,
    decisionsByVideo: Map<string, InitialDecision>,
): boolean {
    const decision = decisionsByVideo.get(video.videoId);

    if (decision?.outcome === "unmatched" && decision.reason === "Excluded by manual override") {
        return false;
    }

    if (decision?.outcome === "matched" && decision.match.eventType !== eventType) {
        return false;
    }

    return true;
}

function buildChronologySequences(
    videos: VideoRecord[],
    playlistOrder: PlaylistOrderFile | null,
): VideoRecord[][] {
    if (!playlistOrder || playlistOrder.playlists.length === 0) {
        return [videos];
    }

    const videoById = new Map(videos.map((video) => [video.videoId, video]));
    const sequences = playlistOrder.playlists
        .map((playlist) => {
            const sequence = playlist.videos
                .sort((left, right) => left.position - right.position)
                .map((entry) => videoById.get(entry.videoId))
                .filter((video): video is VideoRecord => Boolean(video));

            if (sequence.length < 2) {
                return sequence;
            }

            return (sequence[0]?.uploadTimestamp ?? 0) <=
                (sequence.at(-1)?.uploadTimestamp ?? 0)
                ? sequence
                : [...sequence].reverse();
        })
        .filter((sequence) => sequence.length > 0);

    return sequences.length > 0 ? sequences : [videos];
}

function applyGapInferences(
    initialDecisions: InitialDecision[],
    gapInferences: GapInference[],
    eventCandidates: Array<{
        eventType: EventSeriesType;
        eventNumber: number;
        eventLabel: string;
        map: string;
        author: string;
        jsonFileName: string;
        htmlFileName: string;
    }>,
): InitialDecision[] {
    const byVideoId = new Map(initialDecisions.map((decision) => [decision.videoId, decision]));
    const eventLookup = new Map(
        eventCandidates.map((eventCandidate) => [
            `${eventCandidate.eventType}:${eventCandidate.eventNumber}`,
            eventCandidate,
        ]),
    );

    for (const inference of gapInferences) {
        const existingDecision = byVideoId.get(inference.videoId);

        if (!existingDecision) {
            continue;
        }

        if (
            (existingDecision.outcome === "matched" &&
                existingDecision.match.reasons.includes("Confirmed by manual override")) ||
            (existingDecision.outcome === "unmatched" &&
                existingDecision.reason === "Excluded by manual override")
        ) {
            continue;
        }

        if (
            existingDecision.outcome === "matched" &&
            existingDecision.match.eventType === inference.inferredType &&
            existingDecision.match.eventNumber === inference.inferredNumber
        ) {
            continue;
        }

        const targetEvent = eventLookup.get(`${inference.inferredType}:${inference.inferredNumber}`);

        if (!targetEvent) {
            continue;
        }

        byVideoId.set(inference.videoId, {
            videoId: inference.videoId,
            outcome: "matched",
            match: {
                eventType: targetEvent.eventType,
                eventNumber: targetEvent.eventNumber,
                eventLabel: targetEvent.eventLabel,
                map: targetEvent.map,
                author: targetEvent.author,
                jsonFileName: targetEvent.jsonFileName,
                htmlFileName: targetEvent.htmlFileName,
                score: 70,
                confidence: "medium",
                reasons: [
                    "Inferred by chronology gap-fill between two anchored events",
                    `${targetEvent.eventType.toUpperCase()} ${targetEvent.eventNumber} sits between anchored event numbers`,
                ],
                matchedEventPlayers: [],
            },
            alternateCandidates: [],
        });
    }

    return initialDecisions.map((decision) => byVideoId.get(decision.videoId) ?? decision);
}

function buildMatchesByEvent(
    videos: VideoRecord[],
    decisions: InitialDecision[],
): EventMatchOutput[] {
    const videoById = new Map(videos.map((video, index) => [video.videoId, { video, index }]));
    const matchedDecisions = decisions.filter(
        (decision): decision is Extract<InitialDecision, { outcome: "matched" }> =>
            decision.outcome === "matched",
    );

    const matchesByEventKey = new Map<string, EventMatchOutput>();

    for (const decision of matchedDecisions) {
        const videoEntry = videoById.get(decision.videoId);

        if (!videoEntry) {
            continue;
        }

        const key = `${decision.match.eventType}:${decision.match.eventNumber}`;
        const inferredFromGap = decision.match.reasons.some((reason) =>
            reason.includes("chronology gap-fill"),
        );

        const record =
            matchesByEventKey.get(key) ?? {
                eventType: decision.match.eventType,
                eventNumber: decision.match.eventNumber,
                eventLabel: decision.match.eventLabel,
                map: decision.match.map,
                author: decision.match.author,
                jsonFileName: decision.match.jsonFileName,
                htmlFileName: decision.match.htmlFileName,
                videos: [],
            };

        record.videos.push({
            videoId: videoEntry.video.videoId,
            url: videoEntry.video.url,
            title: videoEntry.video.title,
            channel: videoEntry.video.channel,
            uploadDate: videoEntry.video.uploadDate,
            timelineIndex: videoEntry.index,
            score: decision.match.score,
            confidence: decision.match.confidence,
            reasons: decision.match.reasons,
            matchedEventPlayers: decision.match.matchedEventPlayers,
            inferredFromGap,
        });

        matchesByEventKey.set(key, record);
    }

    const output = Array.from(matchesByEventKey.values()).sort(
        (left, right) =>
            getTypeOrder(left.eventType) - getTypeOrder(right.eventType) ||
            left.eventNumber - right.eventNumber,
    );

    for (const eventMatch of output) {
        eventMatch.videos.sort(
            (left, right) => left.timelineIndex - right.timelineIndex || right.score - left.score,
        );
    }

    return output;
}

function buildAmbiguousVideos(
    videos: VideoRecord[],
    decisions: InitialDecision[],
): AmbiguousVideo[] {
    const videoById = new Map(videos.map((video, index) => [video.videoId, { video, index }]));

    return decisions
        .filter(
            (decision): decision is Extract<InitialDecision, { outcome: "ambiguous" }> =>
                decision.outcome === "ambiguous",
        )
        .map((decision) => {
            const videoEntry = videoById.get(decision.videoId);

            if (!videoEntry) {
                return null;
            }

            return {
                videoId: videoEntry.video.videoId,
                url: videoEntry.video.url,
                title: videoEntry.video.title,
                uploadDate: videoEntry.video.uploadDate,
                timelineIndex: videoEntry.index,
                typeSignal: videoEntry.video.typeSignal,
                numberHints: videoEntry.video.numberHints,
                candidates: decision.candidates.map((candidate) => ({
                    eventType: candidate.eventType,
                    eventNumber: candidate.eventNumber,
                    score: candidate.score,
                    confidence: candidate.confidence,
                    reasons: candidate.reasons,
                })),
                reason: decision.reason,
            } satisfies AmbiguousVideo;
        })
        .filter((value): value is AmbiguousVideo => Boolean(value));
}

function buildUnmatchedVideos(
    videos: VideoRecord[],
    decisions: InitialDecision[],
): UnmatchedVideo[] {
    const videoById = new Map(videos.map((video, index) => [video.videoId, { video, index }]));

    return decisions
        .filter(
            (decision): decision is Extract<InitialDecision, { outcome: "unmatched" }> =>
                decision.outcome === "unmatched",
        )
        .map((decision) => {
            const videoEntry = videoById.get(decision.videoId);

            if (!videoEntry) {
                return null;
            }

            return {
                videoId: videoEntry.video.videoId,
                url: videoEntry.video.url,
                title: videoEntry.video.title,
                uploadDate: videoEntry.video.uploadDate,
                timelineIndex: videoEntry.index,
                typeSignal: videoEntry.video.typeSignal,
                numberHints: videoEntry.video.numberHints,
                reason: decision.reason,
            } satisfies UnmatchedVideo;
        })
        .filter((value): value is UnmatchedVideo => Boolean(value));
}

function classifyConfidence(score: number): MatchConfidence {
    if (score >= 95) {
        return "high";
    }

    if (score >= 72) {
        return "medium";
    }

    return "low";
}

function splitAuthorNames(author: string): string[] {
    return author
        .toLowerCase()
        .split(/\s+(?:&|and|\+)\s+/i)
        .map((value) => normalizeText(value))
        .filter(Boolean);
}

function hasStrongMapperEvidence(
    primaryText: string,
    authorName: string,
): boolean {
    if (authorName.length <= 2) {
        return false;
    }

    return [
        `map by ${authorName}`,
        `map made by ${authorName}`,
        `made by ${authorName}`,
        `built by ${authorName}`,
        `${authorName} for making`,
        `${authorName} for building`,
        `${authorName} for creating`,
    ].some((pattern) => primaryText.includes(pattern));
}

function normalizeMapLabel(mapLabel: string): string {
    return normalizeText(
        mapLabel
            .replace(/\bcot[dw]\s*#?\s*\d+\s*[-:]?/gi, " ")
            .replace(/\btroll\s+cot[dw]\s*#?\s*\d+\s*[-:]?/gi, " ")
            .replace(/["']/g, " "),
    );
}

function buildKeywords(value: string): string[] {
    return normalizeText(value)
        .split(" ")
        .filter((token) => token.length >= 4 && !commonWordFilter.has(token));
}

function countTokenOverlap(tokens: string[], haystack: Set<string>): number {
    return tokens.reduce(
        (count, token) => (haystack.has(token) ? count + 1 : count),
        0,
    );
}

function normalizeText(value: string): string {
    return normalizeWhitespace(
        value
            .toLowerCase()
            .replace(/[^a-z0-9\s#-]/g, " ")
            .replace(/\s+/g, " "),
    );
}

function getTypeOrder(eventType: EventSeriesType): number {
    if (eventType === "cotd") {
        return 0;
    }

    if (eventType === "troll") {
        return 1;
    }

    return 2;
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
