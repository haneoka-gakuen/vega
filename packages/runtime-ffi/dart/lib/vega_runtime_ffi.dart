import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';
import 'package:vega_protocol/execution.dart';

export 'package:vega_protocol/execution.dart';
export 'package:vega_protocol/seek.dart';
export 'package:vega_protocol/save.dart';

typedef _CreateNative = Pointer<Void> Function(Pointer<Uint32>, Size);
typedef _DestroyNative = Void Function(Pointer<Void>);
typedef _ControlNative = Int32 Function(Pointer<Void>, Uint32);
typedef _ObserveNative = Int32 Function(Pointer<Void>, Pointer<Int64>);
typedef _BeginNative = Int64 Function(Pointer<Void>, Uint64);
typedef _AdmitNative = Int32 Function(Pointer<Void>, Size, Uint32);
typedef _CompleteNative = Int32 Function(Pointer<Void>, Size, Uint64, Int64);
typedef _RecordNative = Int32 Function(Pointer<Void>, Size, Pointer<Int64>);
typedef _RepositionNative = Int32 Function(Pointer<Void>, Size);
typedef _CheckpointSizeNative = IntPtr Function(Pointer<Void>);
typedef _CheckpointWordsNative = Int32 Function(
  Pointer<Void>,
  Pointer<Int64>,
  Size,
);
typedef _ReplayModeNative = Int32 Function(Pointer<Void>, Uint32);
typedef _BlockingNative = Int64 Function(Pointer<Void>);

final class VegaFfiExecutionDriver
    implements VegaCheckpointExecutionDriver, VegaExecutionOwnershipDriver {
  VegaFfiExecutionDriver._(this._library, List<int> commandIndices) {
    final abi = _library.lookupFunction<Uint32 Function(), int Function()>(
      'vega_execution_abi_version',
    )();
    if (abi != 1) throw StateError('vega_execution_abi:$abi');
    _control = _library
        .lookupFunction<_ControlNative, int Function(Pointer<Void>, int)>(
          'vega_execution_control',
        );
    _observe = _library
        .lookupFunction<
          _ObserveNative,
          int Function(Pointer<Void>, Pointer<Int64>)
        >('vega_execution_observe');
    _begin = _library
        .lookupFunction<_BeginNative, int Function(Pointer<Void>, int)>(
          'vega_execution_begin',
        );
    _admit = _library
        .lookupFunction<_AdmitNative, int Function(Pointer<Void>, int, int)>(
          'vega_execution_admit',
        );
    _complete = _library
        .lookupFunction<
          _CompleteNative,
          int Function(Pointer<Void>, int, int, int)
        >('vega_execution_complete');
    _record = _library
        .lookupFunction<
          _RecordNative,
          int Function(Pointer<Void>, int, Pointer<Int64>)
        >('vega_execution_record');
    _destroy = _library
        .lookupFunction<_DestroyNative, void Function(Pointer<Void>)>(
          'vega_execution_destroy',
        );
    final create = _library
        .lookupFunction<
          _CreateNative,
          Pointer<Void> Function(Pointer<Uint32>, int)
        >('vega_execution_create');
    _reposition = _library
        .lookupFunction<_RepositionNative, int Function(Pointer<Void>, int)>(
          'vega_execution_reposition',
        );
    _checkpointSize = _library
        .lookupFunction<_CheckpointSizeNative, int Function(Pointer<Void>)>(
          'vega_execution_checkpoint_size',
        );
    _checkpointWrite = _library
        .lookupFunction<
          _CheckpointWordsNative,
          int Function(Pointer<Void>, Pointer<Int64>, int)
        >('vega_execution_checkpoint_write');
    _checkpointRestore = _library
        .lookupFunction<
          _CheckpointWordsNative,
          int Function(Pointer<Void>, Pointer<Int64>, int)
        >('vega_execution_checkpoint_restore');
    _replayMode = _library
        .lookupFunction<_ReplayModeNative, int Function(Pointer<Void>, int)>(
          'vega_execution_replay_mode',
        );
    _blocking = _library
        .lookupFunction<_BlockingNative, int Function(Pointer<Void>)>(
          'vega_execution_blocking_id',
        );
    final indices = calloc<Uint32>(
      commandIndices.isEmpty ? 1 : commandIndices.length,
    );
    try {
      for (var i = 0; i < commandIndices.length; i++) {
        final index = commandIndices[i];
        if (index < 0 || index > 0xffffffff)
          throw ArgumentError.value(index, 'commandIndex');
        indices[i] = index;
      }
      _session = create(indices, commandIndices.length);
      if (_session == nullptr)
        throw const FormatException('vega_execution_command_indices');
    } finally {
      calloc.free(indices);
    }
    _scratch = calloc<Int64>(6);
  }

  factory VegaFfiExecutionDriver.open({
    required List<int> commandIndices,
    String? libraryPath,
  }) {
    DynamicLibrary load() {
      if (libraryPath != null) return DynamicLibrary.open(libraryPath);
      if (Platform.isIOS || Platform.isMacOS) return DynamicLibrary.process();
      if (Platform.isAndroid) {
        return DynamicLibrary.open('libvega_runtime.so');
      }
      final filename = Platform.isWindows
          ? 'vega_runtime.dll'
          : 'libvega_runtime.so';
      final directory = File(Platform.resolvedExecutable).parent.path;
      for (final path in ['$directory/lib/$filename', '$directory/$filename']) {
        if (File(path).existsSync()) return DynamicLibrary.open(path);
      }
      return DynamicLibrary.open(filename);
    }

    return VegaFfiExecutionDriver._(load(), commandIndices);
  }

  final DynamicLibrary _library;
  late final Pointer<Void> _session;
  late final Pointer<Int64> _scratch;
  late final int Function(Pointer<Void>, int) _control;
  late final int Function(Pointer<Void>, Pointer<Int64>) _observe;
  late final int Function(Pointer<Void>, int) _begin;
  late final int Function(Pointer<Void>, int, int) _admit;
  late final int Function(Pointer<Void>, int, int, int) _complete;
  late final int Function(Pointer<Void>, int, Pointer<Int64>) _record;
  late final void Function(Pointer<Void>) _destroy;
  late final int Function(Pointer<Void>, int) _reposition;
  late final int Function(Pointer<Void>) _checkpointSize;
  late final int Function(Pointer<Void>, Pointer<Int64>, int) _checkpointWrite,
      _checkpointRestore;
  late final int Function(Pointer<Void>, int) _replayMode;
  late final int Function(Pointer<Void>) _blocking;
  bool _disposed = false;
  List<VegaExecutionRecord>? _history;

  void _alive() {
    if (_disposed) throw StateError('vega_execution_disposed');
  }

  void _check(int status) {
    if (status < 0) throw StateError('vega_execution_status:$status');
  }

  int _value(int index) {
    _alive();
    _check(_observe(_session, _scratch));
    return _scratch[index];
  }

  @override
  int get cursor => _value(0);
  @override
  int get generation => _value(1);
  @override
  bool get playing => _value(2) != 0;
  @override
  int? get blockingExecutionId {
    _alive();
    final id = _blocking(_session);
    if (id == -1) return null;
    _check(id);
    return id;
  }

  @override
  List<VegaExecutionRecord> get history => _history ??= List.unmodifiable([
    for (var i = 0, count = _value(4); i < count; i++) _read(i),
  ]);
  VegaExecutionRecord _read(int id) {
    _check(_record(_session, id, _scratch));
    return VegaExecutionRecord(
      executionId: _scratch[0],
      commandIndex: _scratch[1],
      startedAtUs: _scratch[2],
      completedAtUs: _scratch[3] < 0 ? null : _scratch[3],
      nextCommandIndex: _scratch[4] < 0 ? null : _scratch[4],
      endsSequence: _scratch[4] == -2,
      waitForCompletion: _scratch[5] < 0 ? null : _scratch[5] != 0,
    );
  }

  @override
  bool start() {
    _alive();
    return _control(_session, 0) == 1;
  }

  @override
  VegaExecutionRecord begin(int atUs) {
    _alive();
    if (atUs < 0) throw ArgumentError.value(atUs, 'atUs');
    final id = _begin(_session, atUs);
    _check(id);
    _history = null;
    for (var position = _value(4) - 1; position >= 0; position--) {
      final execution = _read(position);
      if (execution.executionId == id) return execution;
    }
    throw StateError('vega_execution_record_missing:$id');
  }

  @override
  void admit(int executionId, {required bool waitForCompletion}) {
    _alive();
    _check(_admit(_session, executionId, waitForCompletion ? 1 : 0));
    _history = null;
  }

  @override
  void complete(
    int executionId,
    int atUs, {
    int? nextCommandIndex,
    bool endsSequence = false,
  }) {
    _alive();
    _check(
      _complete(
        _session,
        executionId,
        atUs,
        endsSequence ? -2 : nextCommandIndex ?? -1,
      ),
    );
    _history = null;
  }

  @override
  void reposition(int commandPosition) {
    _alive();
    if (commandPosition < 0)
      throw ArgumentError.value(commandPosition, 'commandPosition');
    _check(_reposition(_session, commandPosition));
    _history = null;
  }

  @override
  VegaExecutionCheckpoint captureCheckpoint() {
    _alive();
    final length = _checkpointSize(_session);
    _check(length);
    final values = calloc<Int64>(length);
    try {
      _check(_checkpointWrite(_session, values, length));
      return VegaExecutionCheckpoint.fromWords([
        for (var i = 0; i < length; i++) values[i],
      ]);
    } finally {
      calloc.free(values);
    }
  }

  @override
  void restoreCheckpoint(VegaExecutionCheckpoint checkpoint) {
    _alive();
    final values = calloc<Int64>(checkpoint.words.length);
    try {
      for (var i = 0; i < checkpoint.words.length; i++)
        values[i] = checkpoint.words[i];
      _check(_checkpointRestore(_session, values, checkpoint.words.length));
      _history = null;
    } finally {
      calloc.free(values);
    }
  }

  @override
  VegaFfiExecutionDriver forkReplay(VegaExecutionCheckpoint checkpoint) {
    _alive();
    final fork = VegaFfiExecutionDriver._(_library, checkpoint.commandIndices);
    try {
      fork.restoreCheckpoint(checkpoint);
      fork._check(fork._replayMode(fork._session, 1));
      fork.start();
      return fork;
    } catch (_) {
      fork.dispose();
      rethrow;
    }
  }

  @override
  void pause() {
    _alive();
    _check(_control(_session, 1));
  }

  @override
  void resume() {
    _alive();
    _check(_control(_session, 2));
  }

  @override
  void stop() {
    _alive();
    _check(_control(_session, 3));
  }

  @override
  void finish() {
    _alive();
    _check(_control(_session, 4));
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _destroy(_session);
    calloc.free(_scratch);
    _history = null;
  }
}
