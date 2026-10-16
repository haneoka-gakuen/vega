import 'dart:async';
import 'dart:convert';

import 'execution.dart';
import 'seek.dart';
import 'src/source_identity.dart';

/// Storage and source-specific host codecs remain outside the execution core.
final class VegaSaveEnvelope {
  VegaSaveEnvelope({
    required this.sourceIdentity,
    required this.decisionSignature,
    required this.execution,
    required this.atUs,
    required this.hostCodec,
    required Map<String, Object?> hostData,
  }) : hostData = _jsonValue(hostData) as Map<String, Object?> {
    if (atUs < 0 || hostCodec.isEmpty)
      throw const FormatException('vega_save_header');
  }
  static const version = 1;
  final StorySourceIdentity sourceIdentity;
  final String decisionSignature, hostCodec;
  final VegaExecutionCheckpoint execution;
  final int atUs;
  final Map<String, Object?> hostData;

  Map<String, Object?> toJson() => {
    'version': version,
    'source': sourceIdentity.toJson(),
    'decisionSignature': decisionSignature,
    // Decimal words preserve signed 64-bit values through JSON transports.
    'execution': [for (final word in execution.words) word.toString()],
    'atUs': atUs.toString(), 'hostCodec': hostCodec, 'host': hostData,
  };
  String encode() => jsonEncode(toJson());

  factory VegaSaveEnvelope.decode(String source) =>
      VegaSaveEnvelope.fromJson(jsonDecode(source) as Map);

  factory VegaSaveEnvelope.fromJson(Map data) {
    if (data['version'] != version ||
        data['source'] is! Map ||
        data['execution'] is! List ||
        data['host'] is! Map) {
      throw const FormatException('vega_save_format');
    }
    final identity = data['source'] as Map;
    String text(Map input, String key) {
      final value = input[key];
      if (value is! String || value.isEmpty)
        throw FormatException('vega_save_$key');
      return value;
    }

    int integer(Object? value) {
      if (value is! String) throw const FormatException('vega_save_integer');
      return int.tryParse(value) ??
          (throw const FormatException('vega_save_integer'));
    }

    final signature = data['decisionSignature'];
    if (signature is! String)
      throw const FormatException('vega_save_decisions');
    return VegaSaveEnvelope(
      sourceIdentity: StorySourceIdentity.fromJson(identity),
      decisionSignature: signature,
      execution: VegaExecutionCheckpoint.fromWords(
        (data['execution'] as List).map(integer),
      ),
      atUs: integer(data['atUs']),
      hostCodec: text(data, 'hostCodec'),
      hostData: Map<String, Object?>.from(data['host'] as Map),
    );
  }

  Future<VegaNarrativeCheckpoint<T>> hydrate<T>({
    required StorySourceIdentity expectedSource,
    required String expectedHostCodec,
    required FutureOr<T> Function(Map<String, Object?>) decodeHost,
  }) async {
    if (sourceIdentity != expectedSource || hostCodec != expectedHostCodec) {
      throw const FormatException('vega_save_source_codec');
    }
    final state = await decodeHost(hostData);
    return VegaNarrativeCheckpoint(
      sourceIdentity: sourceIdentity,
      decisionSignature: decisionSignature,
      execution: execution,
      atUs: atUs,
      hostState: state,
    );
  }
}

Object? _jsonValue(Object? value) {
  if (value is Map) {
    final result = <String, Object?>{};
    for (final entry in value.entries) {
      if (entry.key is! String)
        throw const FormatException('vega_save_host_key');
      result[entry.key as String] = _jsonValue(entry.value);
    }
    return Map<String, Object?>.unmodifiable(result);
  }
  return switch (value) {
    null || String() || bool() || int() => value,
    double number when number.isFinite => number,
    List values => List<Object?>.unmodifiable(values.map(_jsonValue)),
    _ => throw const FormatException('vega_save_host_value'),
  };
}
