// HC-T26 M6 Collect tubes (US-07-1/4/5/6; 04-UI-UX §3.6; TRD §6.3 specimen.collected / specimen.not_collected).
// LD-140 (2026-11-13): lims_ui widgets + tokens only, one primary button. Offline: a scan is matched against the tubes
// already on the phone and persisted through MutationSink; a tube is shown collected only after the save completed.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

final _barcodePattern = RegExp(r'^[A-Z0-9]{1,20}$');

class CollectScreen extends StatefulWidget {
  const CollectScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.otherVisitBarcodes,
    required this.sink,
    required this.readGps,
    required this.now,
    required this.onDone,
    this.scannerBuilder,
    this.initialCollected = const {},
    this.initialNotCollected = const {},
  });

  final VisitView visit;
  final VisitConfig config;

  /// Barcodes of OTHER visits cached on this device (wrong-patient tube check).
  final Set<String> otherVisitBarcodes;
  final MutationSink sink;
  final Future<Map<String, Object?>> Function() readGps;
  final DateTime Function() now;
  final VoidCallback onDone;
  final Widget Function(ValueChanged<String> onScanned)? scannerBuilder;

  /// Rebuilt from the mutation log after a force-close: specimen ids already resolved.
  final Set<String> initialCollected;
  final Map<String, String> initialNotCollected; // specimen id -> reason code

  @override
  State<CollectScreen> createState() => _CollectScreenState();
}

class _CollectScreenState extends State<CollectScreen> with SaveOnce<CollectScreen> {
  final _hid = TextEditingController();
  final _hidScope = FocusScopeNode(debugLabel: 'collect.hid');
  final _collected = <String, String?>{}; // specimen id -> "hh:mm" (null = collected earlier, time not kept)
  final _notCollected = <String, String>{}; // specimen id -> reason code
  Future<void> _queue = Future.value();
  bool _camera = false;
  InlineNotice? _notice;

  @override
  void initState() {
    super.initState();
    for (final id in widget.initialCollected) {
      _collected[id] = null;
    }
    _notCollected.addAll(widget.initialNotCollected);
    _focusHid();
  }

  @override
  void dispose() {
    _hid.dispose();
    _hidScope.dispose();
    super.dispose();
  }

  void _focusHid() {
    if (_camera || widget.visit.specimensStale) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !_camera) _hidScope.requestFocus();
    });
  }

  bool get _allResolved => widget.visit.tubes.every((t) => _collected.containsKey(t.specimenId) || _notCollected.containsKey(t.specimenId));

  static String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

  void _feedback({required bool ok}) {
    unawaited(ok ? HapticFeedback.mediumImpact() : HapticFeedback.heavyImpact());
    unawaited(SystemSound.play(ok ? SystemSoundType.click : SystemSoundType.alert));
  }

  void _say(String tone, String text) {
    if (mounted) setState(() => _notice = InlineNotice(tone: tone, text: text));
  }

  /// Scans are handled one at a time, in arrival order: a fast second scan waits for the first save instead of being dropped.
  void _scan(String raw, String method) => _queue = _queue.then((_) => _handleScan(raw, method));

  Future<void> _handleScan(String raw, String method) async {
    if (!mounted) return;
    setState(() => _notice = null);
    final code = LimsBarcodeScanner.accept(raw, _barcodePattern);
    if (code == null) {
      _feedback(ok: false);
      _say('danger', "That isn't a valid barcode.");
      return;
    }
    final tube = widget.visit.tubes.where((t) => t.barcode == code).firstOrNull;
    if (tube == null) {
      _feedback(ok: false);
      _say('danger', widget.otherVisitBarcodes.contains(code) ? "This tube belongs to another patient. Don't use it here." : 'This tube is not on this visit.');
      return;
    }
    if (_collected.containsKey(tube.specimenId)) {
      _feedback(ok: false);
      _say('warning', 'Already collected.');
      return;
    }
    if (_notCollected.containsKey(tube.specimenId)) {
      _feedback(ok: false);
      _say('warning', 'This tube was marked not collected.');
      return;
    }
    final ok = await runSave(() async {
      final gps = await widget.readGps();
      return widget.sink.enqueue(
        type: 'specimen.collected',
        visitId: widget.visit.visitId,
        visitLabel: widget.visit.label,
        payload: {
          'specimen_id': tube.specimenId,
          'scanned_barcode': code,
          'scan_method': method,
          'specimen_type_code': tube.typeCode,
          'gps': gps,
        },
      );
    });
    if (!ok) {
      _feedback(ok: false);
      return;
    }
    _feedback(ok: true);
    if (!mounted) return;
    setState(() {
      _collected[tube.specimenId] = _hhmm(widget.now());
      _notice = InlineNotice(tone: 'success', text: 'Collected ${tube.typeDisplay}');
    });
  }

  Future<void> _markNotCollected(ExpectedTube tube) async {
    final r = await LimsDialog.show<(String, String)>(
      context,
      title: 'Why was this tube not collected?',
      content: _ReasonPicker(reasons: widget.config.notCollectedReasons),
    );
    if (r == null || !mounted) return;
    final text = r.$2.trim();
    final ok = await runSave(() => widget.sink.enqueue(
          type: 'specimen.not_collected',
          visitId: widget.visit.visitId,
          visitLabel: widget.visit.label,
          payload: {
            'specimen_id': tube.specimenId,
            'reason_code': r.$1,
            if (text.isNotEmpty) 'reason_text': text.length > 200 ? text.substring(0, 200) : text,
          },
        ));
    if (ok && mounted) setState(() => _notCollected[tube.specimenId] = r.$1);
  }

  Future<void> _typeBarcode() async {
    final code = await LimsDialog.show<String>(context, title: 'Type barcode', content: const _ManualBarcode());
    if (code != null) _scan(code, 'manual');
  }

  String _reasonDisplay(String code) =>
      widget.config.notCollectedReasons.where((r) => r.code == code).firstOrNull?.display ?? code;

  Widget _tubeRow(ExpectedTube tube) {
    final id = tube.specimenId;
    final done = _collected.containsKey(id) || _notCollected.containsKey(id);
    final String tone;
    final String label;
    if (_collected.containsKey(id)) {
      tone = 'success';
      label = _collected[id] == null ? 'Collected' : 'Collected ${_collected[id]}';
    } else if (_notCollected.containsKey(id)) {
      tone = 'warning';
      label = 'Not collected: ${_reasonDisplay(_notCollected[id]!)}';
    } else {
      tone = 'neutral';
      label = 'Waiting';
    }
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: LimsTokens.space2),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${tube.typeDisplay} · ${tube.container}', style: t.titleSmall),
            Text(tube.last4, style: t.bodyMedium),
            const SizedBox(height: LimsTokens.space1),
            LimsStatusChip(kind: 'generic', status: label, tone: tone, label: label),
          ]),
        ),
        PopupMenuButton<String>(
          key: ValueKey('collect.tube_menu.$id'),
          tooltip: 'Tube options',
          enabled: !done && !saving, // a resolved tube is final
          onSelected: (v) => v == 'type' ? _typeBarcode() : _markNotCollected(tube),
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'not_collected', child: Text('Mark not collected')),
            if (widget.config.manualBarcodeEntryAllowed) const PopupMenuItem(value: 'type', child: Text('Type barcode')),
          ],
        ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    if (v.specimensStale) {
      return LimsSecureScreen(
        child: LimsScaffold(
          title: 'Collect tubes',
          body: ListView(children: const [LimsErrorState(title: 'Tubes unavailable — refresh before collecting')]),
        ),
      );
    }
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Collect tubes',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsButton(
            key: const ValueKey('collect.camera_toggle'),
            label: _camera ? 'Stop camera' : 'Use camera',
            icon: Icons.photo_camera_outlined,
            secondary: true,
            onPressed: () {
              setState(() => _camera = !_camera);
              _focusHid();
            },
          ),
          if (_camera) ...[
            const SizedBox(height: LimsTokens.space2),
            SizedBox(
              height: 240,
              child: widget.scannerBuilder?.call((c) => _scan(c, 'camera')) ?? LimsBarcodeScanner(onScanned: (c) => _scan(c, 'camera')),
            ),
          ],
          const SizedBox(height: LimsTokens.space3),
          FocusScope(
            node: _hidScope,
            child: _SubmitOnDone(
              controller: _hid,
              onSubmit: (raw) {
                _scan(raw, 'hid');
                _focusHid();
              },
              child: LimsTextField(
                key: const ValueKey('collect.hid_input'),
                label: 'Scan tube barcode',
                maxLength: 20,
                sensitive: true,
                controller: _hid,
              ),
            ),
          ),
          if (_notice != null) _notice!,
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          for (final tube in v.tubes) _tubeRow(tube),
          const SizedBox(height: LimsTokens.space4),
          LimsButton(
            label: 'Done collecting',
            onPressed: _allResolved && !saving
                ? () async {
                    await _queue;
                    if (mounted) widget.onDone();
                  }
                : null,
          ),
        ]),
      ),
    );
  }
}

/// Submits the field's text when the keyboard "done"/Enter action ends the edit (a scanner in keyboard mode sends Enter).
/// lims_ui's LimsTextField has no onSubmitted hook; the done action takes the focus away, which is what this listens for.
/// ponytail: tapping elsewhere also submits what is in the field; add onSubmitted to LimsTextField (lims_ui chunk) to drop this.
class _SubmitOnDone extends StatelessWidget {
  const _SubmitOnDone({required this.controller, required this.onSubmit, required this.child});

  final TextEditingController controller;
  final ValueChanged<String> onSubmit;
  final Widget child;

  @override
  Widget build(BuildContext context) => Focus(
        canRequestFocus: false,
        skipTraversal: true,
        onFocusChange: (has) {
          final text = controller.text;
          if (!has && text.trim().isNotEmpty) {
            controller.clear();
            onSubmit(text);
          }
        },
        child: child,
      );
}

/// "Type barcode" (only when manual_barcode_entry_allowed): max 20, uppercased, ^[A-Z0-9]{1,20}$.
class _ManualBarcode extends StatefulWidget {
  const _ManualBarcode();

  @override
  State<_ManualBarcode> createState() => _ManualBarcodeState();
}

class _ManualBarcodeState extends State<_ManualBarcode> {
  final _text = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _submit([String? typed]) {
    final code = LimsBarcodeScanner.accept(typed ?? _text.text, _barcodePattern);
    if (code == null) {
      setState(() => _error = 'Use letters and digits only (up to 20).');
      return;
    }
    Navigator.of(context).pop(code);
  }

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _SubmitOnDone(
          controller: _text,
          onSubmit: _submit, // the done action clears the field first, so use the text it hands over
          child: LimsTextField(
            key: const ValueKey('collect.manual_input'),
            label: 'Barcode',
            maxLength: 20,
            sensitive: true,
            controller: _text,
            errorText: _error,
          ),
        ),
        const SizedBox(height: LimsTokens.space3),
        LimsButton(label: 'Use barcode', onPressed: _submit),
        const SizedBox(height: LimsTokens.space2),
        LimsButton(label: 'Cancel', secondary: true, onPressed: () => Navigator.of(context).pop()),
      ]);
}

/// "Mark not collected": reason list from config + optional text (<= 200). Pops (reason code, text).
class _ReasonPicker extends StatefulWidget {
  const _ReasonPicker({required this.reasons});

  final List<ReasonOption> reasons;

  @override
  State<_ReasonPicker> createState() => _ReasonPickerState();
}

class _ReasonPickerState extends State<_ReasonPicker> {
  final _text = TextEditingController();
  ReasonOption? _picked;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _valid => _picked != null && (!_picked!.requiresText || _text.text.trim().isNotEmpty);

  @override
  Widget build(BuildContext context) => Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final r in widget.reasons) ChoiceTile(title: r.display, selected: _picked == r, onTap: () => setState(() => _picked = r)),
        LimsTextField(
          key: const ValueKey('collect.reason_text'),
          label: 'Details (optional)',
          maxLength: 200,
          controller: _text,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: LimsTokens.space3),
        LimsButton(
          key: const ValueKey('collect.reason_confirm'),
          label: 'Save',
          onPressed: _valid ? () => Navigator.of(context).pop((_picked!.code, _text.text)) : null,
        ),
        const SizedBox(height: LimsTokens.space2),
        LimsButton(label: 'Cancel', secondary: true, onPressed: () => Navigator.of(context).pop()),
      ]);
}
