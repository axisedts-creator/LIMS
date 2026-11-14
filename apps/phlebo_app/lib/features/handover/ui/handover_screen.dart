// HC-T27 M10 Handover (04-UI-UX §3.10; TRD §6.3 handover.recorded). LD-140 (2026-11-13): lims_ui + tokens only.
// One tap on "Hand over {n} tubes" = ONE handover.recorded mutation, persisted through MutationSink BEFORE the screen moves on.
// The mutation has no visit id and carries ids only (no patient data, no barcode).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../outbox/ui/status_pill.dart';
import '../../visit/data/mutation_sink.dart';
import '../../visit/ui/save_once.dart';
import '../domain/handover_models.dart';

const _maxTubes = 50; // specimen_ids is 1..50 (TRD §6.3)

(String, String, IconData)? _result(String? r) => switch (r) {
      'included' => ('success', 'Included', Icons.check_circle_outline),
      'skipped_not_collected' => ('warning', 'Not collected by you', Icons.warning_amber_outlined),
      'skipped_already_handed_over' => ('neutral', 'Already handed over', Icons.info_outline),
      _ => null,
    };

class HandoverScreen extends StatefulWidget {
  const HandoverScreen({
    super.key,
    required this.centres,
    required this.tubes,
    required this.itemResults,
    required this.sink,
    required this.newId,
    required this.onDone,
  });

  final List<HandoverCentre> centres;
  final List<HandoverTube> tubes;

  /// specimenId -> included | skipped_not_collected | skipped_already_handed_over (known only after sync).
  final Map<String, String> itemResults;
  final MutationSink sink;
  final String Function() newId;
  final void Function(String handoverId) onDone;

  @override
  State<HandoverScreen> createState() => _HandoverScreenState();
}

class _HandoverScreenState extends State<HandoverScreen> with SaveOnce<HandoverScreen> {
  late final Set<String> _selected = {for (final t in widget.tubes) t.specimenId};
  late final String _handoverId = widget.newId(); // one id per screen: a retry after a failed save reuses it
  String? _centreId;

  List<String> get _ids => [for (final t in widget.tubes) if (_selected.contains(t.specimenId)) t.specimenId];

  String _last4(String barcode) => '…${barcode.length > 4 ? barcode.substring(barcode.length - 4) : barcode}';

  Future<void> _handOver() async {
    final centre = _centreId;
    final ids = _ids;
    if (centre == null || ids.isEmpty || ids.length > _maxTubes) return;
    final ok = await runSave(() => widget.sink.enqueue(
          type: 'handover.recorded',
          payload: {'handover_id': _handoverId, 'to_centre_id': centre, 'specimen_ids': ids},
        ));
    if (ok) widget.onDone(_handoverId);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final n = _ids.length;
    final tooMany = n > _maxTubes;
    final label = tooMany ? 'Hand over up to $_maxTubes tubes' : (n == 1 ? 'Hand over 1 tube' : 'Hand over $n tubes');
    final canSend = !saving && _centreId != null && n >= 1 && !tooMany;
    final empty = widget.tubes.isEmpty;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Handover',
        bottomNavigationBar: empty
            ? null
            : SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(LimsTokens.space4),
                  child: LimsButton(label: label, onPressed: canSend ? _handOver : null),
                ),
              ),
        body: empty
            ? const LimsEmptyState(title: 'No tubes to hand over', message: 'Tubes you have collected will appear here.')
            : ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
                Text('Give the tubes to the centre staff. They will scan them to confirm.', style: t.bodyLarge),
                const SizedBox(height: LimsTokens.space4),
                Text('Hand over to', style: t.titleMedium),
                for (final c in widget.centres)
                  ChoiceTile(
                    title: c.name,
                    selected: _centreId == c.centreId,
                    onTap: saving ? null : () => setState(() => _centreId = c.centreId),
                  ),
                const SizedBox(height: LimsTokens.space4),
                Text('Tubes', style: t.titleMedium),
                for (final tube in widget.tubes) _tubeRow(tube, t),
                if (tooMany) ...[
                  const SizedBox(height: LimsTokens.space3),
                  const InlineNotice(tone: 'warning', text: 'You can hand over up to $_maxTubes tubes at a time. Untick some tubes.'),
                ],
                const SizedBox(height: LimsTokens.space3),
                saveErrorNotice(),
              ]),
      ),
    );
  }

  Widget _tubeRow(HandoverTube tube, TextTheme t) {
    final r = _result(widget.itemResults[tube.specimenId]);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      LimsListTile(
        key: ValueKey('handover.tube.${tube.specimenId}'),
        leading: Checkbox(
          value: _selected.contains(tube.specimenId),
          onChanged: saving ? null : (_) => _toggle(tube.specimenId),
        ),
        title: tube.typeDisplay,
        subtitle: _last4(tube.barcode),
        onTap: saving ? null : () => _toggle(tube.specimenId),
      ),
      if (r != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(LimsTokens.space16, 0, LimsTokens.space4, LimsTokens.space2),
          child: StatusPill(tone: r.$1, icon: r.$3, label: r.$2),
        ),
    ]);
  }

  void _toggle(String id) => setState(() => _selected.contains(id) ? _selected.remove(id) : _selected.add(id));
}
