// Shared cases (packages/test-fixtures/homecollection/mutation-payload-cases.json) for the enqueue payload check.
// The server runs the SAME file against validateMutationPayload
// (services/api/src/modules/homecollection/__tests__/unit/mutation.shared-cases.test.ts):
// a schema change that is made on one side only fails one of the two suites.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/outbox/data/mutation_payload.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';

File _fixture() {
  var d = Directory.current;
  for (var i = 0; i < 5; i++) {
    final f = File('${d.path}/packages/test-fixtures/homecollection/mutation-payload-cases.json');
    if (f.existsSync()) return f;
    d = d.parent;
  }
  throw StateError('mutation-payload-cases.json not found from ${Directory.current.path}');
}

void main() {
  final cases = ((jsonDecode(_fixture().readAsStringSync()) as Map)['cases'] as List).cast<Map<String, Object?>>();

  test('the cases cover every mutation type with a valid and an invalid case', () {
    for (final t in mutationTypes) {
      expect(cases.any((c) => c['type'] == t && c['valid'] == true), isTrue, reason: '$t valid');
      expect(cases.any((c) => c['type'] == t && c['valid'] == false), isTrue, reason: '$t invalid');
    }
  });

  for (final c in cases) {
    test('${c['name']}', () => expect(mutationPayloadIsValid(c['type']! as String, c['payload']), c['valid']));
  }
}
