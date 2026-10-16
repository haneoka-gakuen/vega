import 'dart:async';

import 'execution.dart';
import 'src/source_identity.dart';

final class VegaNarrativeCheckpoint<T> {
  const VegaNarrativeCheckpoint({
    required this.sourceIdentity,
    required this.decisionSignature,
    required this.execution,
    required this.atUs,
    required this.hostState,
  });
  final StorySourceIdentity sourceIdentity;
  final int version = 1;
  final String decisionSignature;
  final VegaExecutionCheckpoint execution;
  final int atUs;
  final T hostState;
  int get commandPosition => execution.cursor;
}

final class VegaSeekContext {
  const VegaSeekContext({
    required this.revision,
    required this.decisionSignature,
    required this.isCurrent,
  });
  final int revision;
  final String decisionSignature;
  final bool Function() isCurrent;
  bool get deterministicReplay => true;
  void checkCurrent() {
    if (!isCurrent()) throw const VegaSeekCancelled();
  }
}

final class VegaSeekCancelled implements Exception {
  const VegaSeekCancelled();
}

final class VegaReplayCompletion {
  const VegaReplayCompletion({
    required this.atUs,
    this.nextCommandIndex,
    this.endsSequence = false,
  });
  final int atUs;
  final int? nextCommandIndex;
  final bool endsSequence;
}

final class VegaReplayOperation {
  const VegaReplayOperation({
    required this.waitForCompletion,
    required this.completion,
  });
  final bool waitForCompletion;
  final Future<VegaReplayCompletion> completion;
}

final class VegaSeekIndexCompilation {
  const VegaSeekIndexCompilation({
    required this.processed,
    required this.commandCount,
    this.blockedAt,
  });
  final int processed, commandCount;
  final int? blockedAt;
  bool get complete => blockedAt == null;
}

/// Each state contains the host's scene, media, resource and presentation
/// ownership. Restore/settle/present must acknowledge actual backend work.
abstract interface class VegaNarrativeSeekHost<T> {
  StorySourceIdentity get sourceIdentity;
  int get logicalTimeUs;
  Future<VegaExecutionCheckpoint> quiesce(VegaSeekContext context);
  Future<T> capture(VegaSeekContext context);
  Future<void> restore(
    T state, {
    required int atUs,
    required VegaSeekContext context,
  });
  Future<void> settle(VegaSeekContext context);
  Future<void> present(VegaSeekContext context);
  Future<VegaReplayOperation> replay(
    VegaExecutionRecord execution,
    VegaSeekContext context, {
    bool resuming = false,
  });
  Future<VegaReplayCompletion> waitForReplay(
    Future<VegaReplayCompletion> completion,
    VegaSeekContext context,
  );

  /// Restore the host clock and pause state. Resume starts a fresh playback
  /// loop because the previous generation was retired before replay.
  Future<void> finishSeek({
    required bool resume,
    required int atUs,
    required VegaSeekContext context,
  });
}

/// Completion listeners belong to this fork, not to a later live driver.
final class _ReplayRun<T> {
  _ReplayRun(this.driver, this.host, this.context);
  final VegaCheckpointExecutionDriver driver;
  final VegaNarrativeSeekHost<T> host;
  final VegaSeekContext context;
  final _pending = <int, Future<VegaReplayCompletion>>{};
  bool _alive = true;
  Object? _failure;
  StackTrace? _stack;

  void check() {
    context.checkCurrent();
    if (!_alive) throw const VegaSeekCancelled();
    if (_failure != null) Error.throwWithStackTrace(_failure!, _stack!);
  }

  Future<VegaReplayCompletion> _track(
    VegaExecutionRecord execution,
    VegaReplayOperation operation,
  ) {
    final future = operation.completion.then((completion) {
      if (_alive && context.isCurrent()) {
        driver.complete(
          execution.executionId,
          completion.atUs,
          nextCommandIndex: completion.nextCommandIndex,
          endsSequence: completion.endsSequence,
        );
      }
      return completion;
    });
    _pending[execution.executionId] = future;
    unawaited(
      future.then<void>(
        (_) {
          _pending.remove(execution.executionId);
        },
        onError: (Object error, StackTrace stack) {
          _pending.remove(execution.executionId);
          if (_alive && context.isCurrent()) {
            _failure = error;
            _stack = stack;
          }
        },
      ),
    );
    return future;
  }

  Future<void> reconnect() async {
    for (final id in driver.captureCheckpoint().activeExecutionIds) {
      final execution = driver.history.singleWhere(
        (row) => row.executionId == id,
      );
      final operation = await host.replay(execution, context, resuming: true);
      check();
      if (operation.waitForCompletion != execution.waitForCompletion) {
        throw const FormatException('vega_replay_restored_admission');
      }
      _track(execution, operation);
    }
    await Future<void>.value();
    check();
  }

  Future<void> step() async {
    check();
    final blocker = driver.captureCheckpoint().blockingExecutionId;
    if (blocker != null) {
      final completion = _pending[blocker];
      if (completion == null) throw StateError('vega_replay_blocker_unbound');
      await host.waitForReplay(completion, context);
    } else {
      final execution = driver.begin(host.logicalTimeUs);
      final operation = await host.replay(execution, context);
      check();
      driver.admit(
        execution.executionId,
        waitForCompletion: operation.waitForCompletion,
      );
      final completion = _track(execution, operation);
      if (operation.waitForCompletion)
        await host.waitForReplay(completion, context);
    }
    await host.settle(context);
    await Future<void>.value();
    check();
  }

  void close() => _alive = false;
}

/// One decision path owns an ordered set of settled command boundaries.
/// A missing target is rebuilt from its real anchor, not cursor repositioning.
final class VegaNarrativeSeekCoordinator<T> {
  VegaNarrativeSeekCoordinator({
    required this.driver,
    required this.host,
    this.checkpointInterval = 32,
    this.maxCachedCheckpoints = 32,
  }) {
    if (checkpointInterval < 1 || maxCachedCheckpoints < 3) {
      throw ArgumentError('vega_seek_cache_budget');
    }
  }
  final VegaCheckpointExecutionDriver driver;
  final VegaNarrativeSeekHost<T> host;
  final int checkpointInterval, maxCachedCheckpoints;
  final _paths = <String, Map<int, VegaNarrativeCheckpoint<T>>>{};
  final _used = <(String, int), int>{};
  final _preparedAnchors = <(String, int)>{};
  int _usage = 0;
  String? _activePath;
  (String, int)? _target;
  int _revision = 0;
  Future<void>? _active;
  bool _disposed = false;
  bool get seeking => _active != null;
  int get indexCheckpointBudget {
    final available = maxCachedCheckpoints - 2;
    return maxCachedCheckpoints - (available < 4 ? available : 4);
  }

  Map<String, Object?> get checkpointStoreObservation => {
    'interval': checkpointInterval,
    'capacity': maxCachedCheckpoints,
    'preparedAnchors': _preparedAnchors.length,
    'indexBudget': indexCheckpointBudget,
    'checkpoints': _used.length,
    'decisionPaths': _paths.length,
    'executionWords': _paths.values
        .expand((path) => path.values)
        .fold<int>(0, (total, value) => total + value.execution.words.length),
    'positions': {
      for (final entry in _paths.entries)
        entry.key: entry.value.keys.toList()..sort(),
    },
  };

  VegaSeekContext _context(int revision, String signature) => VegaSeekContext(
    revision: revision,
    decisionSignature: signature,
    isCurrent: () => !_disposed && revision == _revision,
  );

  void remember(VegaNarrativeCheckpoint<T> checkpoint) {
    if (checkpoint.sourceIdentity != host.sourceIdentity) {
      throw const FormatException('vega_seek_source_identity');
    }
    _activePath = checkpoint.decisionSignature;
    (_paths[checkpoint.decisionSignature] ??= {})[checkpoint.commandPosition] =
        checkpoint;
    final key = (checkpoint.decisionSignature, checkpoint.commandPosition);
    _used[key] = ++_usage;
    while (_used.length > maxCachedCheckpoints) {
      final candidates =
          _used.keys
              .where(
                (value) =>
                    value != key &&
                    value != _target &&
                    !(value.$1 == _activePath &&
                        _preparedAnchors.contains(value)) &&
                    value != (_activePath, 0),
              )
              .toList()
            ..sort((a, b) => _used[a]!.compareTo(_used[b]!));
      if (candidates.isEmpty) break;
      final oldest = candidates.first;
      _used.remove(oldest);
      _preparedAnchors.remove(oldest);
      final path = _paths[oldest.$1]!;
      path.remove(oldest.$2);
      if (path.isEmpty) _paths.remove(oldest.$1);
    }
  }

  VegaNarrativeCheckpoint<T>? checkpointAt(int position, String signature) =>
      _paths[signature]?[position];

  Future<VegaNarrativeCheckpoint<T>> capture({
    required String decisionSignature,
  }) async {
    if (seeking) throw StateError('vega_seek_active');
    final context = _context(_revision, decisionSignature);
    final execution = await host.quiesce(context);
    await host.settle(context);
    context.checkCurrent();
    final state = await host.capture(context);
    context.checkCurrent();
    final value = VegaNarrativeCheckpoint(
      sourceIdentity: host.sourceIdentity,
      decisionSignature: decisionSignature,
      execution: execution,
      atUs: host.logicalTimeUs,
      hostState: state,
    );
    await host.restore(state, atUs: value.atUs, context: context);
    await host.settle(context);
    await host.present(context);
    context.checkCurrent();
    driver.restoreCheckpoint(execution);
    await host.finishSeek(resume: false, atUs: value.atUs, context: context);
    remember(value);
    return value;
  }

  Future<void> seek(
    int target, {
    required String decisionSignature,
    bool resume = false,
  }) {
    _activePath = decisionSignature;
    _target = (decisionSignature, target);
    final revision = ++_revision;
    final previous = _active;
    final work = () async {
      if (previous != null) {
        try {
          await previous;
        } catch (_) {
          /* Superseded work retires before the next host restore. */
        }
      }
      final context = _context(revision, decisionSignature);
      context.checkCurrent();
      final path = _paths[decisionSignature];
      final anchor = path?[0];
      final exact = path?[target];
      var selected = exact ?? anchor;
      if (exact == null && path != null) {
        for (final value in path.values) {
          if (value.commandPosition <= target &&
              (selected == null ||
                  value.commandPosition > selected.commandPosition)) {
            selected = value;
          }
        }
      }
      if (selected == null) throw StateError('vega_seek_anchor_missing');
      if (target < 0 || target > selected.execution.commandCount)
        throw RangeError.value(target, 'target');
      if (selected.sourceIdentity != host.sourceIdentity)
        throw const FormatException('vega_seek_source_identity');
      _used[(decisionSignature, selected.commandPosition)] = ++_usage;
      final rollbackExecution = await host.quiesce(context);
      context.checkCurrent();
      final rollbackState = await host.capture(context);
      final rollbackTime = host.logicalTimeUs;
      context.checkCurrent();
      final replay = driver.forkReplay(selected.execution);
      final run = _ReplayRun<T>(replay, host, context);
      VegaNarrativeCheckpoint<T>? targetCheckpoint = exact;
      var replayed = 0;
      try {
        await host.restore(
          selected.hostState,
          atUs: selected.atUs,
          context: context,
        );
        await host.settle(context);
        context.checkCurrent();
        if (exact == null) {
          await run.reconnect();
          final visited = <int>{};
          while (replay.cursor != target) {
            if (replay.cursor >= selected.execution.commandCount ||
                !visited.add(replay.cursor)) {
              throw StateError('vega_seek_target_unreachable:$target');
            }
            await run.step();
            replayed++;
            if (replay.cursor == target || replayed % checkpointInterval == 0) {
              final state = await host.capture(context);
              run.check();
              final value = VegaNarrativeCheckpoint(
                sourceIdentity: host.sourceIdentity,
                decisionSignature: decisionSignature,
                execution: replay.captureCheckpoint(),
                atUs: host.logicalTimeUs,
                hostState: state,
              );
              context.checkCurrent();
              if (replay.cursor == target) {
                targetCheckpoint = value;
              } else {
                remember(value);
              }
            }
          }
        }
        await host.settle(context);
        context.checkCurrent();
        await host.present(context);
        run.check();
        final targetState = targetCheckpoint!;
        run.close();
        if (exact == null) {
          await host.restore(
            targetState.hostState,
            atUs: targetState.atUs,
            context: context,
          );
          await host.settle(context);
          await host.present(context);
          context.checkCurrent();
        }
        // Logical cursor publication follows successful resource presentation.
        driver.restoreCheckpoint(targetState.execution);
        remember(targetState);
        await host.finishSeek(
          resume: resume,
          atUs: targetState.atUs,
          context: context,
        );
      } catch (_) {
        run.close();
        if (!_disposed) {
          // Requests serialize host work. Recovery belongs to the latest
          // revision before the queued request can inspect the live scene.
          final recovery = VegaSeekContext(
            revision: _revision,
            decisionSignature: decisionSignature,
            isCurrent: () => !_disposed,
          );
          await host.restore(
            rollbackState,
            atUs: rollbackTime,
            context: recovery,
          );
          await host.settle(recovery);
          await host.present(recovery);
          recovery.checkCurrent();
          driver.restoreCheckpoint(rollbackExecution);
          await host.finishSeek(
            resume: false,
            atUs: rollbackTime,
            context: recovery,
          );
        }
        rethrow;
      } finally {
        run.close();
        replay.dispose();
      }
    }();
    _active = work;
    return work.whenComplete(() {
      if (identical(_active, work)) _active = null;
    });
  }

  Future<void> restore(
    VegaNarrativeCheckpoint<T> checkpoint, {
    bool resume = false,
  }) {
    remember(checkpoint);
    return seek(
      checkpoint.commandPosition,
      decisionSignature: checkpoint.decisionSignature,
      resume: resume,
    );
  }

  /// Prepares selected boundaries before playback, then restores the anchor.
  /// The host supplies source barriers; the coordinator owns cancellation,
  /// failure recovery and the bounded cache. Active playback is never stolen.
  Future<VegaSeekIndexCompilation> compileIndex({
    required String decisionSignature,
    required Set<int> checkpointPositions,
    bool Function(int position)? canReplay,
    void Function(int processed, int commandCount)? onProgress,
  }) {
    final revision = ++_revision;
    final previous = _active;
    late VegaSeekIndexCompilation result;
    final work = () async {
      if (previous != null) {
        try {
          await previous;
        } catch (_) {
          // Superseded transactions restore before this transaction begins.
        }
      }
      final context = _context(revision, decisionSignature);
      context.checkCurrent();
      final anchor = _paths[decisionSignature]?[0];
      if (anchor == null) throw StateError('vega_seek_anchor_missing');
      if (driver.cursor != 0 || driver.playing) {
        throw StateError('vega_seek_index_requires_initial_boundary');
      }
      final count = anchor.execution.commandCount;
      if (checkpointPositions.any((value) => value < 0 || value > count)) {
        throw RangeError('vega_seek_index_positions');
      }
      if (checkpointPositions.length > indexCheckpointBudget) {
        throw ArgumentError('vega_seek_index_budget');
      }
      _activePath = decisionSignature;
      _target = (decisionSignature, 0);
      _preparedAnchors.removeWhere((key) => key.$1 == decisionSignature);
      _preparedAnchors.add((decisionSignature, 0));
      var returnState = anchor.hostState;
      var returnExecution = anchor.execution;
      VegaCheckpointExecutionDriver? replay;
      _ReplayRun<T>? run;
      var processed = 0;
      int? blockedAt;
      try {
        returnExecution = await host.quiesce(context);
        context.checkCurrent();
        returnState = await host.capture(context);
        context.checkCurrent();
        replay = driver.forkReplay(anchor.execution);
        run = _ReplayRun<T>(replay, host, context);
        await host.restore(
          anchor.hostState,
          atUs: anchor.atUs,
          context: context,
        );
        await host.settle(context);
        context.checkCurrent();
        await run.reconnect();
        onProgress?.call(0, count);
        final visited = <int>{};
        while (replay.cursor < count) {
          final position = replay.cursor;
          if (!visited.add(position) || canReplay?.call(position) == false) {
            blockedAt = position;
            break;
          }
          await run.step();
          if (checkpointPositions.contains(replay.cursor)) {
            final state = await host.capture(context);
            run.check();
            remember(
              VegaNarrativeCheckpoint(
                sourceIdentity: host.sourceIdentity,
                decisionSignature: decisionSignature,
                execution: replay.captureCheckpoint(),
                atUs: host.logicalTimeUs,
                hostState: state,
              ),
            );
            _preparedAnchors.add((decisionSignature, replay.cursor));
          }
          processed++;
          onProgress?.call(processed, count);
        }
        result = VegaSeekIndexCompilation(
          processed: processed,
          commandCount: count,
          blockedAt: blockedAt,
        );
      } finally {
        run?.close();
        try {
          if (!_disposed) {
            final recovery = VegaSeekContext(
              revision: _revision,
              decisionSignature: decisionSignature,
              isCurrent: () => !_disposed,
            );
            await host.restore(
              returnState,
              atUs: anchor.atUs,
              context: recovery,
            );
            await host.settle(recovery);
            await host.present(recovery);
            recovery.checkCurrent();
            driver.restoreCheckpoint(returnExecution);
            await host.finishSeek(
              resume: false,
              atUs: anchor.atUs,
              context: recovery,
            );
          }
        } finally {
          replay?.dispose();
        }
      }
    }();
    _active = work;
    return work
        .whenComplete(() {
          if (identical(_active, work)) _active = null;
        })
        .then((_) => result);
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    ++_revision;
    _paths.clear();
    _used.clear();
    _preparedAnchors.clear();
  }
}
