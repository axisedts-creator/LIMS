// HC-T26 M3 Visit (US-07-1; 04-UI-UX §3.3). LD-140 (2026-11-13): lims_ui widgets + tokens only, one primary button.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

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
  });

  final VisitView visit;
  final VisitConfig config;
  final MutationSink sink;
  final Future<Map<String, Object?>> Function() readGps;
  final Future<void> Function(Uri) launchUri;
  final VoidCallback onArrived;
  final VoidCallback onCannotDo;

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

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: v.label,
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsCard(
            title: 'Patient',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(v.patientName, style: t.titleMedium),
              const SizedBox(height: LimsTokens.space2),
              LimsButton(
                label: 'Call',
                icon: Icons.call_outlined,
                secondary: true,
                onPressed: () => widget.launchUri(Uri(scheme: 'tel', path: v.phone)),
              ),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Address',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(v.address),
              Text('Landmark: ${v.landmark}'),
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
            child: Text('${v.windowStart}–${v.windowEnd}'),
          ),
          if (v.noteFromCentre != null && v.noteFromCentre!.isNotEmpty) ...[
            const SizedBox(height: LimsTokens.space3),
            LimsCard(title: 'Note from centre', child: Text(v.noteFromCentre!)),
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
                        subtitle: tube.last4,
                        leading: const Icon(Icons.science_outlined),
                      ),
                  ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Amount due',
            child: Text('NPR ${formatPaisa(v.amountDuePaisa)} as of ${v.amountAsOf}'),
          ),
          const SizedBox(height: LimsTokens.space4),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: "I've arrived", onPressed: saving ? null : _arrive),
          const SizedBox(height: LimsTokens.space2),
          LimsButton(label: "Can't do this visit", secondary: true, onPressed: saving ? null : widget.onCannotDo),
        ]),
      ),
    );
  }
}
