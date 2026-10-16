final class VegaExecutionRecord {
  const VegaExecutionRecord({
    required this.executionId,
    required this.commandIndex,
    required this.startedAtUs,
    this.completedAtUs,
    this.nextCommandIndex,
    this.waitForCompletion,
    this.endsSequence = false,
  });
  final int executionId, commandIndex, startedAtUs;
  final int? completedAtUs, nextCommandIndex;
  final bool? waitForCompletion;
  final bool endsSequence;
}

abstract interface class VegaExecutionDriver {
  int get cursor;
  int get generation;
  bool get playing;
  List<VegaExecutionRecord> get history;
  bool start();
  VegaExecutionRecord begin(int atUs);
  void admit(int executionId, {required bool waitForCompletion});
  void complete(
    int executionId,
    int atUs, {
    int? nextCommandIndex,
    bool endsSequence = false,
  });
  void reposition(int commandPosition);
  void pause();
  void resume();
  void stop();
  void finish();
  void dispose();
}

/// Current ownership is independent of cancelled, incomplete history rows.
abstract interface class VegaExecutionOwnershipDriver {
  int? get blockingExecutionId;
}

/// Portable execution words contain command identities and history, never
/// renderer handles. Host snapshots carry their own source/content identity.
final class VegaExecutionCheckpoint {
  VegaExecutionCheckpoint.fromWords(Iterable<int> values)
    : words = List<int>.unmodifiable(values) {
    if (words.length < 5 ||
        (words[0] != 1 && words[0] != 2) ||
        words[1] < 0 ||
        words[2] < 0 ||
        words[2] > words[1] ||
        words[3] < 0 ||
        words[4] < 0 ||
        words[1] > words.length - 5 ||
        words[3] > (words.length - 5 - words[1]) ~/ 6 ||
        (words[0] == 1 && words.length != _historyEnd) ||
        (words[0] == 2 && words.length < _historyEnd + 2)) {
      throw const FormatException('vega_execution_checkpoint');
    }
    final commands = commandIndices.toSet();
    if (commands.length != commandCount ||
        commands.any((index) => index < 0 || index > 0xffffffff)) {
      throw const FormatException('vega_execution_checkpoint_commands');
    }
    final records = <int, (int, int, int, int)>{};
    var previousStart = 0;
    for (var offset = 5 + commandCount; offset < _historyEnd; offset += 6) {
      final id = words[offset], command = words[offset + 1];
      final start = words[offset + 2], end = words[offset + 3];
      final next = words[offset + 4], wait = words[offset + 5];
      if (id < 0 ||
          id >= words[4] ||
          records.containsKey(id) ||
          !commands.contains(command) ||
          start < previousStart ||
          (end != -1 && end < start) ||
          !const [-1, 0, 1].contains(wait) ||
          (next < -2 || (next >= 0 && !commands.contains(next))) ||
          (end >= 0 && wait == -1) ||
          (end == -1 && next != -1)) {
        throw const FormatException('vega_execution_checkpoint_history');
      }
      previousStart = start;
      records[id] = (command, start, end, wait);
    }
    if (version == 2) {
      final count = words[_historyEnd], blocker = words[_historyEnd + 1];
      if (count < 0 ||
          words.length != _historyEnd + 2 + count ||
          blocker < -1) {
        throw const FormatException('vega_execution_checkpoint_active');
      }
      final active = <int>{}, blocking = <int>[];
      for (final id in words.skip(_historyEnd + 2)) {
        final record = records[id];
        if (!active.add(id) ||
            record == null ||
            record.$3 != -1 ||
            record.$4 == -1) {
          throw const FormatException('vega_execution_checkpoint_active');
        }
        if (record.$4 == 1) {
          blocking.add(id);
          if (cursor >= commandCount || commandIndices[cursor] != record.$1) {
            throw const FormatException('vega_execution_checkpoint_blocker');
          }
        }
      }
      if (blocking.length > 1 ||
          (blocking.isEmpty ? blocker != -1 : blocker != blocking.single)) {
        throw const FormatException('vega_execution_checkpoint_blocker');
      }
    }
  }
  final List<int> words;
  int get version => words[0];
  int get _historyEnd => 5 + words[1] + words[3] * 6;
  int get commandCount => words[1];
  int get cursor => words[2];
  List<int> get commandIndices =>
      List.unmodifiable(words.sublist(5, 5 + commandCount));
  List<int> get activeExecutionIds =>
      version == 1 ? const [] : List.unmodifiable(words.skip(_historyEnd + 2));
  int? get blockingExecutionId => version == 1 || words[_historyEnd + 1] == -1
      ? null
      : words[_historyEnd + 1];

  /// Upgrade only ownership supplied explicitly by the restoring host.
  VegaExecutionCheckpoint withActiveExecutions(
    Iterable<int> executionIds, {
    int? blockingExecutionId,
  }) {
    final active = executionIds.toList()..sort();
    return VegaExecutionCheckpoint.fromWords([
      2,
      ...words.skip(1).take(_historyEnd - 1),
      active.length,
      blockingExecutionId ?? -1,
      ...active,
    ]);
  }
}

abstract interface class VegaCheckpointExecutionDriver
    implements VegaExecutionDriver {
  VegaExecutionCheckpoint captureCheckpoint();
  void restoreCheckpoint(VegaExecutionCheckpoint checkpoint);
  VegaCheckpointExecutionDriver forkReplay(VegaExecutionCheckpoint checkpoint);
}
