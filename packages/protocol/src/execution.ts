/** Opaque source identity shared by host snapshots and their execution log. */
export interface VegaCheckpointSourceIdentity {
  readonly namespace: string;
  readonly revision: string;
  readonly resourceScope: string;
  readonly document: string;
  readonly contentIdentity: string;
}

export interface VegaExecutionCheckpoint {
  readonly version: 1 | 2;
  readonly words: readonly number[];
  readonly cursor: number;
  readonly commandCount: number;
  readonly activeExecutionIds: readonly number[];
  readonly blockingExecutionId: number | null;
}

export interface VegaNarrativeCheckpoint<THost = unknown> {
  readonly version: 1;
  readonly sourceIdentity: VegaCheckpointSourceIdentity;
  readonly decisionSignature: string;
  readonly execution: VegaExecutionCheckpoint;
  readonly atUs: number;
  readonly hostState: THost;
}

export function executionCheckpointFromWords(input: ArrayLike<number>): VegaExecutionCheckpoint {
  const words = Array.from(input);
  const commandCount = words[1]!, cursor = words[2]!, historyCount = words[3]!;
  const historyEnd = 5 + commandCount + historyCount * 6;
  if (words.length < 5 || words.some((value) => !Number.isSafeInteger(value)) ||
    (words[0] !== 1 && words[0] !== 2) ||
    commandCount < 0 || cursor < 0 || cursor > commandCount || historyCount < 0 ||
    words[4]! < 0 || !Number.isSafeInteger(historyEnd) ||
    (words[0] === 1 ? words.length !== historyEnd : words.length < historyEnd + 2)) {
    throw new TypeError("Vega execution checkpoint words are invalid");
  }
  const commands = new Set(words.slice(5, 5 + commandCount));
  if (commands.size !== commandCount || [...commands].some((index) => index < 0 || index > 0xffffffff))
    throw new TypeError("Vega checkpoint commands are invalid");
  const records = new Map<number, { command: number; end: number; wait: number }>();
  let previousStart = 0;
  for (let offset = 5 + commandCount; offset < historyEnd; offset += 6) {
    const id = words[offset]!, command = words[offset + 1]!, start = words[offset + 2]!;
    const end = words[offset + 3]!, next = words[offset + 4]!, wait = words[offset + 5]!;
    if (id < 0 || id >= words[4]! || records.has(id) || !commands.has(command) || start < previousStart ||
      (end !== -1 && end < start) || ![-1, 0, 1].includes(wait) ||
      next < -2 || (next >= 0 && !commands.has(next)) ||
      (end >= 0 && wait === -1) || (end === -1 && next !== -1)) {
      throw new TypeError("Vega checkpoint history is invalid");
    }
    previousStart = start;
    records.set(id, { command, end, wait });
  }
  const activeExecutionIds = words[0] === 1 ? [] : words.slice(historyEnd + 2);
  const blockingExecutionId = words[0] === 1 || words[historyEnd + 1] === -1
    ? null : words[historyEnd + 1]!;
  if (words[0] === 2) {
    if (words[historyEnd]! < 0 || activeExecutionIds.length !== words[historyEnd] ||
      words[historyEnd + 1]! < -1 || new Set(activeExecutionIds).size !== activeExecutionIds.length) {
      throw new TypeError("Vega checkpoint active executions are invalid");
    }
    let blocker: number | null = null;
    for (const id of activeExecutionIds) {
      const record = records.get(id);
      if (!record || record.end !== -1 || record.wait === -1)
        throw new TypeError("Vega checkpoint active execution is invalid");
      if (record.wait === 1) {
        if (blocker !== null || words[5 + cursor] !== record.command || cursor >= commandCount)
          throw new TypeError("Vega checkpoint blocker is invalid");
        blocker = id;
      }
    }
    if (blocker !== blockingExecutionId) throw new TypeError("Vega checkpoint blocker is invalid");
  }
  return Object.freeze({ version: words[0] as 1 | 2, words: Object.freeze(words), cursor, commandCount,
    activeExecutionIds: Object.freeze(activeExecutionIds), blockingExecutionId });
}
