// HC-T26 M3 Visit (US-07-1; 04-UI-UX §3.3). LD-140 (2026-11-13): lims_ui widgets + tokens only, one primary button.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';
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
    this.onMyWay,
    this.travelStatus,
  });

  /// PHLEBO-UI-FULL-1 "On my way": starts sharing the position with the patient. Null on success, else the sentence to
  /// show. When this is null (preview without it, tests) the screen is as before.
  final Future<String?> Function()? onMyWay;

  /// Null = not travelling. 'live' | 'no_position' | 'offline' while on the way.
  final String? travelStatus;

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
  bool _starting = false;
  String? _travelError;

  Future<void> _onMyWay() async {
    if (_starting) return;
    setState(() {
      _starting = true;
      _travelError = null;
    });
    final error = await widget.onMyWay!();
    if (mounted) {
      setState(() {
        _starting = false;
        _travelError = error;
      });
    }
  }

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
        // PHLEBO-UI-FULL-1 C01: the two actions stay pinned under the scrolling details.
        bottomNavigationBar: BottomActions(children: [
          saveErrorNotice(),
          if (_travelError != null) NoticeCard(tone: 'warning', text: _travelError!),
          if (widget.onMyWay != null && widget.travelStatus == null) ...[
            LimsButton(key: const ValueKey('visit.on_my_way'), label: _starting ? 'Starting…' : 'On my way', icon: Icons.navigation_outlined, onPressed: saving || _starting ? null : _onMyWay),
            LimsButton(label: "I've already arrived", secondary: true, onPressed: saving || _starting ? null : _arrive),
          ] else
            LimsButton(label: "I've arrived", onPressed: saving ? null : _arrive),
          LimsButton(label: "Can't do this visit", secondary: true, onPressed: saving ? null : widget.onCannotDo),
        ]),
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          if (widget.travelStatus != null) ...[
            NoticeCard(
              tone: widget.travelStatus == 'live' ? 'success' : 'warning',
              icon: Icons.navigation_outlined,
              title: 'On the way',
              text: switch (widget.travelStatus) {
                'live' => 'The patient can see that you are coming and where you are. Sharing stops when you arrive.',
                'offline' => 'No connection: the patient sees your last position until you are back online.',
                _ => 'The patient is told you are coming. Your position is not available: check that location is on.',
              },
            ),
            const SizedBox(height: LimsTokens.space3),
          ],
          LimsCard(
            title: 'Patient',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                PersonAvatar(name: v.patientName),
                const SizedBox(width: LimsTokens.space3),
                Expanded(child: Text(v.patientName, style: t.titleLarge)),
              ]),
              const SizedBox(height: LimsTokens.space3),
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
        ]),
      ),
    );
  }
}
