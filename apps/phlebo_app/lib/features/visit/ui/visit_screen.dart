// HC-T26 M3 Visit (US-07-1; 04-UI-UX §3.3). LD-140 (2026-11-13): lims_ui widgets + tokens only, one primary button.
// T0A-M5 look: patient header with avatar and chips, flags and fasting as tone panels, tubes with their tests, actions
// pinned at the bottom. Optional travel step ("On my way") for hosts that have it; without it the screen is the M3 of the spec.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../../ui/visit_labels.dart';
import '../../travel/domain/travel_models.dart';
import '../../travel/ui/travel_card.dart';
import '../data/mutation_sink.dart';
import '../domain/visit_models.dart';
import 'save_once.dart';

class VisitScreen extends StatefulWidget {
  const VisitScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.sink,
    required this.readGps,
    required this.launchUri,
    required this.onArrived,
    required this.onCannotDo,
    this.travel,
    this.onStartTravel,
    this.onOpenLocationSettings,
  });

  final VisitView visit;
  final VisitConfig config;
  final MutationSink sink;
  final Future<Map<String, Object?>> Function() readGps;
  final Future<void> Function(Uri) launchUri;
  final VoidCallback onArrived;
  final VoidCallback onCannotDo;

  /// Travel state; null = this host has no "On my way" step and the screen behaves exactly like M3 of the spec.
  final TravelState? travel;
  final VoidCallback? onStartTravel;
  final VoidCallback? onOpenLocationSettings;

  @override
  State<VisitScreen> createState() => _VisitScreenState();
}

class _VisitScreenState extends State<VisitScreen> with SaveOnce<VisitScreen> {
  Future<void> _arrive() async {
    final ok = await runSave(() async {
      final gps = await widget.readGps();
      return widget.sink.enqueue(
        type: 'visit.arrived',
        visitId: widget.visit.visitId,
        visitLabel: widget.visit.label,
        payload: {'gps': gps},
      );
    });
    if (ok) widget.onArrived();
  }

  bool get _canStartTravel => widget.travel != null && !widget.travel!.onTheWay && widget.onStartTravel != null;

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    final t = Theme.of(context).textTheme;
    final chips = <Widget>[
      if (kindLabel(v.kind) != null) LimsStatusChip(kind: 'generic', status: v.kind, tone: kindTone(v.kind, kindLabel(v.kind)!), label: kindLabel(v.kind)),
      for (final f in v.flags) if (flagLabel(f) != null && flagLabel(f) != kindLabel(v.kind)) LimsStatusChip(kind: 'generic', status: f, tone: 'warning', label: flagLabel(f)),
      if (v.needsFasting) const LimsStatusChip(kind: 'generic', status: 'fasting', tone: 'warning', label: 'Fasting sample'),
    ];
    return LimsSecureScreen(
      child: LimsScaffold(
        title: v.label,
        bottomNavigationBar: PhleboActionBar(children: [
          if (saveError != null) saveErrorNotice(),
          if (_canStartTravel) ...[
            LimsButton(label: 'On my way', icon: Icons.navigation_outlined, onPressed: widget.onStartTravel),
            LimsButton(label: "I've already arrived", secondary: true, onPressed: saving ? null : _arrive),
          ] else
            LimsButton(label: "I've arrived", onPressed: saving ? null : _arrive),
          LimsButton(label: "Can't do this visit", secondary: true, onPressed: saving ? null : widget.onCannotDo),
        ]),
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PhleboAvatar(name: v.patientName, size: LimsTokens.space12 + LimsTokens.space1),
                const SizedBox(width: LimsTokens.space3),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(v.patientName, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                    if (v.ageSex != null) Text(v.ageSex!, style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                  ]),
                ),
              ]),
              if (chips.isNotEmpty) ...[
                const SizedBox(height: LimsTokens.space3),
                Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: chips),
              ],
              const SizedBox(height: LimsTokens.space3),
              LimsButton(
                label: 'Call',
                icon: Icons.call_outlined,
                secondary: true,
                onPressed: () => widget.launchUri(Uri(scheme: 'tel', path: v.phone)),
              ),
            ]),
          ),
          if (v.flags.contains('address_missing')) ...[
            const SizedBox(height: LimsTokens.space3),
            const PhleboNotice(tone: 'warning', title: 'Address needed', text: 'The centre has no full address for this visit. Call dispatch before you leave.'),
          ],
          if (v.kind == 'recollection') ...[
            const SizedBox(height: LimsTokens.space3),
            PhleboNotice(tone: 'warning', icon: Icons.replay, title: 'Recollection visit', text: v.recollectionReason ?? 'The lab asked for a new sample. Use the new tube labels.'),
          ],
          if (v.kind == 'revisit') ...[
            const SizedBox(height: LimsTokens.space3),
            const PhleboNotice(tone: 'info', icon: Icons.replay, title: 'Revisit', text: 'Collect only the tubes that were left out last time.'),
          ],
          if (widget.travel != null) ...[
            const SizedBox(height: LimsTokens.space3),
            TravelCard(state: widget.travel!, onOpenLocationSettings: widget.onOpenLocationSettings),
          ],
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Address',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(v.address),
              Text('Landmark: ${v.landmark}', style: t.bodyMedium?.copyWith(color: LimsTokens.colorNeutral600)),
              if (widget.config.mapHandoffEnabled) ...[
                const SizedBox(height: LimsTokens.space2),
                LimsButton(
                  label: 'Navigate',
                  icon: Icons.navigation_outlined,
                  secondary: true,
                  onPressed: () => widget.launchUri(Uri(scheme: 'geo', path: '0,0', queryParameters: {'q': v.address})),
                ),
              ],
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Window',
            child: Row(children: [
              const Icon(Icons.schedule, color: LimsTokens.colorAccentDefault),
              const SizedBox(width: LimsTokens.space2),
              Text('${v.windowStart}–${v.windowEnd}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            ]),
          ),
          if (v.noteFromCentre != null && v.noteFromCentre!.isNotEmpty) ...[
            const SizedBox(height: LimsTokens.space3),
            LimsCard(title: 'Note from centre', child: Text(v.noteFromCentre!)),
          ],
          if (v.needsFasting) ...[
            const SizedBox(height: LimsTokens.space3),
            PhleboNotice(tone: 'warning', title: 'Fasting needed', text: 'For ${v.fastingTests.join(', ')}. Ask the patient whether they have fasted before you collect.'),
          ],
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Tubes to collect',
            child: v.specimensStale
                ? const LimsErrorState(title: 'Tubes unavailable — refresh before collecting')
                : Column(children: [
                    for (final tube in v.tubes)
                      LimsListTile(
                        title: '${tube.typeDisplay} · ${tube.container}',
                        subtitle: tube.tests.isEmpty ? tube.last4 : '${tube.last4} · ${tube.tests.join(', ')}',
                        leading: Icon(Icons.science_outlined, color: limsTone(tubeToneFor('${tube.typeDisplay} ${tube.container}')).fg),
                      ),
                  ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Amount due',
            child: Text('NPR ${formatPaisa(v.amountDuePaisa)} as of ${v.amountAsOf}'),
          ),
          const SizedBox(height: LimsTokens.space4),
        ]),
      ),
    );
  }
}
