type BayesConfig = {
  initialDeviation: number;
  minDeviation: number;
  maxDeviation: number;
  deviationDrift: number;
  performanceVariance: number;
};

export type RatingSnapshot = {
  current: number;
  peak: number;
  deviation: number | null;
  volatility: number | null;
};

export type DriverRatingSummary = {
  elo: RatingSnapshot;
  bayes: RatingSnapshot;
};

export type DriverEventRating = {
  elo: number;
  bayes: number;
};

export type RatingParticipant = {
  canonicalName: string;
  placing: number | null;
};

export type EventRatings = {
  elo: Map<string, number>;
  summary: Map<string, DriverRatingSummary>;
  history: Map<string, Map<string, DriverEventRating>>;
};

type BayesianPlayerState = {
  rating: number;
  deviation: number;
  peak: number;
  starts: number;
  lastEventIndex: number | null;
};

export const initialElo = 1500;
const eloKFactor = 32;
export const bayesConfig: BayesConfig = {
  initialDeviation: 300,
  minDeviation: 40,
  maxDeviation: 350,
  deviationDrift: 20,
  performanceVariance: 200 ** 2,
};

export function buildEventRatings<EventRecord extends { eventKey: string }>(
  eventRecords: EventRecord[],
  getParticipants: (eventRecord: EventRecord) => RatingParticipant[],
): EventRatings {
  const elo = new Map<string, number>();
  const eloPeak = new Map<string, number>();
  const bayes = new Map<string, BayesianPlayerState>();
  const history = new Map<string, Map<string, DriverEventRating>>();

  for (const [eventIndex, eventRecord] of eventRecords.entries()) {
    const participants = getParticipants(eventRecord);

    if (participants.length === 0) {
      continue;
    }

    for (const participant of participants) {
      ensureEloParticipant(participant.canonicalName, elo, eloPeak);
      ensureBayesianParticipant(participant.canonicalName, bayes, bayesConfig);
    }

    applyEloEventResults(participants, elo, eloPeak);
    applyBayesianEventResults(participants, bayes, eventIndex, bayesConfig);

    for (const participant of participants) {
      if (!history.has(participant.canonicalName)) {
        history.set(participant.canonicalName, new Map());
      }

      history.get(participant.canonicalName)?.set(eventRecord.eventKey, {
        elo: elo.get(participant.canonicalName) ?? initialElo,
        bayes: bayes.get(participant.canonicalName)?.rating ?? initialElo,
      });
    }
  }

  const finalEventIndex = eventRecords.length - 1;
  finalizeBayesianStates(bayes, finalEventIndex, bayesConfig);

  return {
    elo,
    summary: buildDriverRatingSummaryMap(elo, eloPeak, bayes),
    history,
  };
}

function ensureEloParticipant(
  canonicalName: string,
  elo: Map<string, number>,
  peaks: Map<string, number>,
): void {
  if (!elo.has(canonicalName)) {
    elo.set(canonicalName, initialElo);
  }

  if (!peaks.has(canonicalName)) {
    peaks.set(canonicalName, initialElo);
  }
}

function ensureBayesianParticipant(
  canonicalName: string,
  states: Map<string, BayesianPlayerState>,
  config: BayesConfig,
): void {
  if (!states.has(canonicalName)) {
    states.set(canonicalName, {
      rating: initialElo,
      deviation: config.initialDeviation,
      peak: initialElo,
      starts: 0,
      lastEventIndex: null,
    });
  }
}

function applyEloEventResults(
  participants: RatingParticipant[],
  eloRatings: Map<string, number>,
  eloPeaks: Map<string, number>,
): void {
  if (participants.length === 0) {
    return;
  }

  const adjustments = new Map<string, number>();
  const pairScale = Math.max(1, participants.length - 1);

  for (const participant of participants) {
    adjustments.set(participant.canonicalName, 0);
  }

  for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < participants.length;
      rightIndex += 1
    ) {
      const left = participants[leftIndex];
      const right = participants[rightIndex];
      const leftRating = eloRatings.get(left.canonicalName) ?? initialElo;
      const rightRating = eloRatings.get(right.canonicalName) ?? initialElo;
      const expectedLeft = 1 / (1 + 10 ** ((rightRating - leftRating) / 400));
      const actualLeft = comparePlacings(left.placing, right.placing);
      const change = (eloKFactor / pairScale) * (actualLeft - expectedLeft);

      adjustments.set(
        left.canonicalName,
        (adjustments.get(left.canonicalName) ?? 0) + change,
      );
      adjustments.set(
        right.canonicalName,
        (adjustments.get(right.canonicalName) ?? 0) - change,
      );
    }
  }

  for (const participant of participants) {
    const current = eloRatings.get(participant.canonicalName) ?? initialElo;
    const next = current + (adjustments.get(participant.canonicalName) ?? 0);

    eloRatings.set(participant.canonicalName, next);
    eloPeaks.set(
      participant.canonicalName,
      Math.max(eloPeaks.get(participant.canonicalName) ?? initialElo, next),
    );
  }
}

function applyBayesianEventResults(
  participants: RatingParticipant[],
  states: Map<string, BayesianPlayerState>,
  eventIndex: number,
  config: BayesConfig,
): void {
  if (participants.length === 0) {
    return;
  }

  const preparedStates = new Map<string, BayesianPlayerState>();

  for (const participant of participants) {
    const state = states.get(participant.canonicalName);

    if (!state) {
      continue;
    }

    preparedStates.set(
      participant.canonicalName,
      prepareBayesianStateForEvent(state, eventIndex, config),
    );
  }

  const nextStates = new Map<string, BayesianPlayerState>();

  for (const participant of participants) {
    const currentState = preparedStates.get(participant.canonicalName);

    if (!currentState) {
      continue;
    }

    const priorVariance = currentState.deviation ** 2;
    let precisionGain = 0;
    let gradient = 0;

    for (const opponent of participants) {
      if (opponent.canonicalName === participant.canonicalName) {
        continue;
      }

      const opponentState = preparedStates.get(opponent.canonicalName);

      if (!opponentState) {
        continue;
      }

      const scaleSquared =
        2 * config.performanceVariance +
        priorVariance +
        opponentState.deviation ** 2;
      const scale = Math.sqrt(scaleSquared);
      const expected =
        1 /
        (1 + Math.exp(-(currentState.rating - opponentState.rating) / scale));
      const score = comparePlacings(participant.placing, opponent.placing);

      precisionGain += (expected * (1 - expected)) / scaleSquared;
      gradient += (score - expected) / scale;
    }

    const posteriorVariance =
      precisionGain === 0
        ? priorVariance
        : 1 / (1 / priorVariance + precisionGain);
    const rating = currentState.rating + posteriorVariance * gradient;
    const deviation = Math.max(
      config.minDeviation,
      Math.min(config.maxDeviation, Math.sqrt(posteriorVariance)),
    );

    nextStates.set(participant.canonicalName, {
      rating,
      deviation,
      peak: Math.max(currentState.peak, rating),
      starts: currentState.starts + 1,
      lastEventIndex: eventIndex,
    });
  }

  for (const [canonicalName, nextState] of nextStates) {
    states.set(canonicalName, nextState);
  }
}

function prepareBayesianStateForEvent(
  state: BayesianPlayerState,
  eventIndex: number,
  config: BayesConfig,
): BayesianPlayerState {
  const elapsedPeriods =
    state.lastEventIndex === null
      ? 0
      : Math.max(0, eventIndex - state.lastEventIndex);

  return {
    ...state,
    deviation: inflateDeviation(
      state.deviation,
      elapsedPeriods,
      config.deviationDrift,
      config.maxDeviation,
    ),
  };
}

function finalizeBayesianStates(
  states: Map<string, BayesianPlayerState>,
  finalEventIndex: number,
  config: BayesConfig,
): void {
  for (const [canonicalName, state] of states) {
    const elapsedPeriods =
      state.lastEventIndex === null
        ? 0
        : Math.max(0, finalEventIndex - state.lastEventIndex);

    states.set(canonicalName, {
      ...state,
      deviation: inflateDeviation(
        state.deviation,
        elapsedPeriods,
        config.deviationDrift,
        config.maxDeviation,
      ),
    });
  }
}

function buildDriverRatingSummaryMap(
  elo: Map<string, number>,
  eloPeak: Map<string, number>,
  bayes: Map<string, BayesianPlayerState>,
): Map<string, DriverRatingSummary> {
  const names = new Set<string>([
    ...elo.keys(),
    ...eloPeak.keys(),
    ...bayes.keys(),
  ]);

  return new Map(
    Array.from(names).map((canonicalName) => [
      canonicalName,
      buildDriverRatingSummary(
        elo.get(canonicalName) ?? initialElo,
        eloPeak.get(canonicalName) ?? initialElo,
        bayes.get(canonicalName) ?? null,
      ),
    ]),
  );
}

function buildDriverRatingSummary(
  eloRating: number,
  eloPeak: number,
  bayesState: BayesianPlayerState | null,
): DriverRatingSummary {
  return {
    elo: {
      current: eloRating,
      peak: eloPeak,
      deviation: null,
      volatility: null,
    },
    bayes: {
      current: bayesState?.rating ?? initialElo,
      peak: bayesState?.peak ?? initialElo,
      deviation: bayesState?.deviation ?? bayesConfig.initialDeviation,
      volatility: null,
    },
  };
}

function inflateDeviation(
  deviation: number,
  elapsedPeriods: number,
  periodDrift: number,
  maxDeviation: number,
): number {
  if (elapsedPeriods <= 0) {
    return deviation;
  }

  return Math.min(
    maxDeviation,
    Math.sqrt(deviation ** 2 + elapsedPeriods * periodDrift ** 2),
  );
}

function comparePlacings(
  leftPlacing: number | null,
  rightPlacing: number | null,
): number {
  if (leftPlacing === rightPlacing) {
    return 0.5;
  }

  if (leftPlacing === null) {
    return 0;
  }

  if (rightPlacing === null) {
    return 1;
  }

  return leftPlacing < rightPlacing ? 1 : 0;
}
