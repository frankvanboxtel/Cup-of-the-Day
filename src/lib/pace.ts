export type PaceParticipant = {
  canonicalName: string;
  placing: number | null;
  timeMs: number | null;
};

export type PaceSnapshot = {
  current: number;
  peak: number;
  starts: number;
};

export type DriverPaceSummary = {
  index: PaceSnapshot;
  form: PaceSnapshot;
};

export type DriverEventPace = {
  eventScore: number;
  pace: number;
  paceForm: number;
  adjustedTimeMs: number | null;
};

export type PaceRatings = {
  summary: Map<string, DriverPaceSummary>;
  history: Map<string, Map<string, DriverEventPace>>;
};

type PacePlayerState = {
  scores: number[];
  indexPeak: number;
  formPeak: number;
};

type EventPaceScore = {
  eventScore: number;
  adjustedTimeMs: number | null;
};

export const initialPaceScore = 50;
const recentFormWindow = 10;
const paceIndexShrinkage = 5;

export function buildEventPaceScores<EventRecord extends { eventKey: string }>(
  eventRecords: EventRecord[],
  getParticipants: (eventRecord: EventRecord) => PaceParticipant[],
): PaceRatings {
  const states = new Map<string, PacePlayerState>();
  const history = new Map<string, Map<string, DriverEventPace>>();

  for (const eventRecord of eventRecords) {
    const participants = getParticipants(eventRecord);

    if (participants.length === 0) {
      continue;
    }

    const eventScores = buildEventScoreMap(participants);

    for (const participant of participants) {
      const score = eventScores.get(participant.canonicalName);

      if (!score) {
        continue;
      }

      const state =
        states.get(participant.canonicalName) ??
        createInitialPacePlayerState();
      const nextScores = [...state.scores, score.eventScore];
      const pace = computePaceIndex(nextScores);
      const paceForm = computePaceForm(nextScores, pace);

      states.set(participant.canonicalName, {
        scores: nextScores,
        indexPeak: Math.max(state.indexPeak, pace),
        formPeak: Math.max(state.formPeak, paceForm),
      });

      if (!history.has(participant.canonicalName)) {
        history.set(participant.canonicalName, new Map());
      }

      history.get(participant.canonicalName)?.set(eventRecord.eventKey, {
        eventScore: score.eventScore,
        pace,
        paceForm,
        adjustedTimeMs: score.adjustedTimeMs,
      });
    }
  }

  return {
    summary: new Map(
      Array.from(states.entries()).map(([canonicalName, state]) => {
        const pace = computePaceIndex(state.scores);
        const paceForm = computePaceForm(state.scores, pace);

        return [
          canonicalName,
          {
            index: {
              current: pace,
              peak: state.indexPeak,
              starts: state.scores.length,
            },
            form: {
              current: paceForm,
              peak: state.formPeak,
              starts: state.scores.length,
            },
          } satisfies DriverPaceSummary,
        ];
      }),
    ),
    history,
  };
}

function createInitialPacePlayerState(): PacePlayerState {
  return {
    scores: [],
    indexPeak: initialPaceScore,
    formPeak: initialPaceScore,
  };
}

function buildEventScoreMap(
  participants: PaceParticipant[],
): Map<string, EventPaceScore> {
  const orderedParticipants = [...participants].sort(comparePaceParticipants);
  const participantCount = orderedParticipants.length;
  const lastKnownTimes = new Array<number | null>(orderedParticipants.length).fill(
    null,
  );

  for (let index = orderedParticipants.length - 1; index >= 0; index -= 1) {
    const participant = orderedParticipants[index];
    const currentTime = participant?.timeMs ?? null;
    const nextKnownTime =
      index + 1 < orderedParticipants.length ? lastKnownTimes[index + 1] : null;

    lastKnownTimes[index] = currentTime ?? nextKnownTime;
  }

  const scoredParticipants = orderedParticipants
    .map((participant, index) => ({
      participant,
      scoringTimeMs: participant.timeMs ?? lastKnownTimes[index],
    }))
    .filter(
      (entry): entry is {
        participant: PaceParticipant & { placing: number };
        scoringTimeMs: number;
      } => entry.participant.placing !== null && entry.scoringTimeMs !== null,
    );
  const adjustedTimes = applyIsotonicTimes(
    scoredParticipants.map((entry) => entry.scoringTimeMs),
  );
  const topAnchor = adjustedTimes[0] ?? null;
  const medianAnchor = adjustedTimes.length === 0 ? null : median(adjustedTimes);
  const hasStableTimeAnchors =
    topAnchor !== null &&
    medianAnchor !== null &&
    Number.isFinite(topAnchor) &&
    Number.isFinite(medianAnchor) &&
    medianAnchor > topAnchor;
  const alpha = hasStableTimeAnchors ? Math.min(1, scoredParticipants.length / 8) : 0;
  const eventScores = new Map<string, EventPaceScore>();

  for (const [index, entry] of scoredParticipants.entries()) {
    const participant = entry.participant;
    const placementScore = buildPlacementScore(
      participant.placing,
      participantCount,
    );
    const timeScore =
      hasStableTimeAnchors && topAnchor !== null && medianAnchor !== null
        ? clamp(
            0,
            100,
            100 -
              (50 *
                (Math.log(adjustedTimes[index] ?? participant.timeMs) -
                  Math.log(topAnchor))) /
                Math.max(1e-9, Math.log(medianAnchor) - Math.log(topAnchor)),
          )
        : placementScore;
    const eventScore = clamp(
      0,
      100,
      alpha * timeScore + (1 - alpha) * placementScore,
    );

    eventScores.set(participant.canonicalName, {
      eventScore,
      adjustedTimeMs: adjustedTimes[index] ?? entry.scoringTimeMs,
    });
  }

  const slowestFinisherScore =
    scoredParticipants.length === 0
      ? null
      : Math.min(
          ...scoredParticipants.map(
            (entry) => eventScores.get(entry.participant.canonicalName)?.eventScore ?? 0,
          ),
        );

  for (const participant of orderedParticipants) {
    if (eventScores.has(participant.canonicalName)) {
      continue;
    }

    const placementScore = buildPlacementScore(
      participant.placing,
      participantCount,
    );
    const dnfBase = clamp(0, 100, 10 + 40 * (placementScore / 100));
    const eventScore =
      slowestFinisherScore === null
        ? clamp(0, 100, placementScore * 0.45)
        : clamp(0, 100, Math.min(dnfBase, slowestFinisherScore - 2));

    eventScores.set(participant.canonicalName, {
      eventScore,
      adjustedTimeMs: null,
    });
  }

  return eventScores;
}

function comparePaceParticipants(
  left: PaceParticipant,
  right: PaceParticipant,
): number {
  const leftPlacing = left.placing ?? Number.MAX_SAFE_INTEGER;
  const rightPlacing = right.placing ?? Number.MAX_SAFE_INTEGER;

  if (leftPlacing !== rightPlacing) {
    return leftPlacing - rightPlacing;
  }

  return left.canonicalName.localeCompare(right.canonicalName);
}

function applyIsotonicTimes(values: number[]): number[] {
  if (values.length <= 1) {
    return [...values];
  }

  const blocks: Array<{ sum: number; count: number; indices: number[] }> = [];

  for (const [index, value] of values.entries()) {
    blocks.push({ sum: value, count: 1, indices: [index] });

    while (blocks.length >= 2) {
      const current = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];

      if (!current || !previous || previous.sum / previous.count <= current.sum / current.count) {
        break;
      }

      blocks.splice(blocks.length - 2, 2, {
        sum: previous.sum + current.sum,
        count: previous.count + current.count,
        indices: [...previous.indices, ...current.indices],
      });
    }
  }

  const adjusted = new Array<number>(values.length);

  for (const block of blocks) {
    const averageValue = block.sum / block.count;

    for (const index of block.indices) {
      adjusted[index] = averageValue;
    }
  }

  return adjusted;
}

function buildPlacementScore(
  placing: number | null,
  participantCount: number,
): number {
  if (placing === null || participantCount <= 0) {
    return 0;
  }

  return 100 * (1 - (placing - 1) / Math.max(1, participantCount - 1));
}

function computePaceIndex(scores: number[]): number {
  if (scores.length === 0) {
    return initialPaceScore;
  }

  const lowerBound = quantile(scores, 0.25);
  const winsorizedMean = average(
    scores.map((score) => Math.max(score, lowerBound)),
  );
  const sampleWeight = scores.length / (scores.length + paceIndexShrinkage);

  return clamp(
    0,
    100,
    sampleWeight * winsorizedMean + (1 - sampleWeight) * initialPaceScore,
  );
}

function computePaceForm(scores: number[], paceIndex: number): number {
  if (scores.length === 0) {
    return initialPaceScore;
  }

  const recentCount = Math.min(recentFormWindow, scores.length);
  const recentScores = scores.slice(-recentCount);
  const recentMean = average(recentScores);
  const recentWeight = recentCount / recentFormWindow;

  return clamp(
    0,
    100,
    recentWeight * recentMean + (1 - recentWeight) * paceIndex,
  );
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const clampedPercentile = clamp(0, 1, percentile);
  const index = (sorted.length - 1) * clampedPercentile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lowerValue = sorted[lowerIndex] ?? sorted[0] ?? 0;
  const upperValue = sorted[upperIndex] ?? lowerValue;

  if (lowerIndex === upperIndex) {
    return lowerValue;
  }

  return lowerValue + (upperValue - lowerValue) * (index - lowerIndex);
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
