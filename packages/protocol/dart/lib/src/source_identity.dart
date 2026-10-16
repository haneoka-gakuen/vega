/// Opaque provider, revision and content identities carried across story ports.
final class StorySourceIdentity {
  const StorySourceIdentity({
    required this.namespace,
    required this.revision,
    required this.resourceScope,
    required this.document,
    required this.contentIdentity,
  });
  final String namespace, revision, resourceScope, document, contentIdentity;

  Map<String, Object?> toJson() => {
    'namespace': namespace,
    'revision': revision,
    'resourceScope': resourceScope,
    'document': document,
    'contentIdentity': contentIdentity,
  };
  factory StorySourceIdentity.fromJson(Map data) {
    String text(String key) {
      final value = data[key];
      if (value is! String || value.isEmpty) {
        throw FormatException('vega_source_$key');
      }
      return value;
    }

    return StorySourceIdentity(
      namespace: text('namespace'),
      revision: text('revision'),
      resourceScope: text('resourceScope'),
      document: text('document'),
      contentIdentity: text('contentIdentity'),
    );
  }

  String get server => namespace;
  String get release => revision;
  String get sourceId => resourceScope;
  String get sourceHash => contentIdentity;

  @override
  bool operator ==(Object other) =>
      other is StorySourceIdentity &&
      namespace == other.namespace &&
      revision == other.revision &&
      resourceScope == other.resourceScope &&
      document == other.document &&
      contentIdentity == other.contentIdentity;
  @override
  int get hashCode => Object.hash(
    namespace,
    revision,
    resourceScope,
    document,
    contentIdentity,
  );
}
