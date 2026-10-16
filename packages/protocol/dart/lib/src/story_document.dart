import 'source_identity.dart';

final class StoryDecodedCommand {
  StoryDecodedCommand({
    required this.index,
    required this.opcode,
    required this.durationUs,
    required this.delayUs,
    required this.noWait,
    required this.ignoreData,
    required List<String> parameters,
    required List<String> targets,
    required Map<String, String> resourceRefs,
    required List<String> voiceIds,
    required List<String> voiceRefs,
    required this.bgmId,
    required this.seId,
    required this.videoId,
    required Map<String, Object?> payload,
    this.opcodeName,
  }) : parameters = List.unmodifiable(parameters),
       targets = List.unmodifiable(targets),
       resourceRefs = Map.unmodifiable(resourceRefs),
       voiceIds = List.unmodifiable(voiceIds),
       voiceRefs = List.unmodifiable(voiceRefs),
       payload = Map.unmodifiable(payload);
  final int index, opcode, durationUs, delayUs;
  final bool noWait, ignoreData;
  final List<String> parameters, targets, voiceIds, voiceRefs;
  final String bgmId, seId, videoId;
  final Map<String, String> resourceRefs;
  final Map<String, Object?> payload;
  final String? opcodeName;
  bool get isKnownOpcode => opcodeName != null;
  bool get isKnownNativeOpcode => isKnownOpcode;
  StoryDecodedCommand withNoWait(bool value) => StoryDecodedCommand(
    index: index,
    opcode: opcode,
    durationUs: durationUs,
    delayUs: delayUs,
    noWait: value,
    ignoreData: ignoreData,
    parameters: parameters,
    targets: targets,
    resourceRefs: resourceRefs,
    voiceIds: voiceIds,
    voiceRefs: voiceRefs,
    bgmId: bgmId,
    seId: seId,
    videoId: videoId,
    payload: payload,
    opcodeName: opcodeName,
  );
  String? parameter(int index) =>
      index < parameters.length ? parameters[index] : null;
  double? numericParameter(int index) {
    final value = parameter(index);
    if (value == null || value.trim().isEmpty) return null;
    final parsed = double.tryParse(value);
    return parsed != null && parsed.isFinite ? parsed : null;
  }
}

/// A normalized story program; format adapters own interpretation of extensions.
final class StoryChapterDocument {
  StoryChapterDocument({
    required this.sourceIdentity,
    required List<StoryDecodedCommand> commands,
    Map<String, Object?> assets = const {},
    Map<String, Object?> document = const {},
  }) : commands = List.unmodifiable(commands),
       assets = Map.unmodifiable(assets),
       document = Map.unmodifiable(document);
  final StorySourceIdentity sourceIdentity;
  final List<StoryDecodedCommand> commands;
  final Map<String, Object?> assets, document;
}
