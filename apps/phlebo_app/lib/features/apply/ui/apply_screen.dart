// PHLEBO-UI-FULL-1: "Apply to join" form, reached from the sign-in screen. lims_ui + tokens only. The screen takes two
// callbacks (pick a file, send the application) and never touches the network or storage itself.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';
import '../domain/application.dart';

class ApplyScreen extends StatefulWidget {
  const ApplyScreen({super.key, required this.pickFile, required this.submit, required this.onClose});

  /// Opens the phone's file or photo picker; null when the person cancels.
  final Future<PickedFile?> Function(DocKind kind) pickFile;

  /// Null on success, else the sentence to show. The draft stays on screen after a failure.
  final Future<String?> Function(ApplicationDraft draft) submit;
  final VoidCallback onClose;

  @override
  State<ApplyScreen> createState() => _ApplyScreenState();
}

class _ApplyScreenState extends State<ApplyScreen> {
  final _draft = ApplicationDraft();
  Map<String, String> _problems = const {};
  String? _error;
  bool _busy = false;
  bool _sent = false;

  Future<void> _add(DocKind kind) async {
    final file = await widget.pickFile(kind);
    if (file == null || !mounted) return;
    final problem = file.problem(kind);
    setState(() {
      if (problem != null) {
        _problems = {..._problems, 'doc.${kind.name}': problem};
      } else {
        _draft.documents[kind]!.add(file);
        _problems = {..._problems}..remove('doc.${kind.name}');
      }
    });
  }

  Future<void> _send() async {
    final problems = _draft.problems();
    setState(() {
      _problems = problems;
      _error = problems.isEmpty ? null : 'Some details are missing. Check the messages above.';
    });
    if (problems.isNotEmpty || _busy) return;
    setState(() => _busy = true);
    final error = await widget.submit(_draft);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
      _sent = error == null;
    });
  }

  Widget _problem(String key) => _problems[key] == null
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(top: LimsTokens.space1),
          child: Semantics(
            liveRegion: true,
            child: Text(_problems[key]!, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: LimsTokens.colorToneDangerFg)),
          ),
        );

  Widget _choice<T>(String label, T value, T? group, ValueChanged<T> onPick) => LimsListTile(
        title: label,
        leading: Icon(value == group ? Icons.radio_button_checked : Icons.radio_button_unchecked),
        onTap: _busy ? null : () => setState(() => onPick(value)),
      );

  Widget _docs(DocKind kind) {
    final files = _draft.documents[kind]!;
    final full = files.length >= maxFilesPerKind[kind]!;
    return Padding(
      padding: const EdgeInsets.only(bottom: LimsTokens.space3),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(docLabels[kind]!, style: Theme.of(context).textTheme.titleSmall),
        for (final f in files)
          LimsListTile(
            leading: const Icon(Icons.insert_drive_file_outlined),
            title: f.name,
            trailing: Semantics(
              button: true,
              label: 'Remove ${f.name}',
              child: InkResponse(
                onTap: _busy ? null : () => setState(() => files.remove(f)),
                child: const SizedBox.square(dimension: LimsTokens.touchTargetFlutter, child: Icon(Icons.close)),
              ),
            ),
          ),
        if (!full)
          LimsButton(
            key: ValueKey('apply.add.${kind.name}'),
            label: files.isEmpty ? 'Add file' : 'Add another',
            icon: Icons.upload_file,
            secondary: true,
            onPressed: _busy ? null : () => _add(kind),
          ),
        _problem('doc.${kind.name}'),
      ]),
    );
  }

  // REQ-SEC-109: the form shows identity details and documents, so screenshots and the app switcher are masked.
  @override
  Widget build(BuildContext context) => LimsSecureScreen(child: _page(context));

  Widget _page(BuildContext context) {
    if (_sent) {
      return LimsScaffold(
        title: 'Application sent',
        bottomNavigationBar: BottomActions(children: [LimsButton(label: 'Back to sign in', onPressed: widget.onClose)]),
        body: const StatePage(
          icon: Icons.check_circle_outline,
          tone: 'success',
          title: 'Application sent',
          message: 'The lab will review your details and documents. If you are approved you will get an SMS on your '
              'number with a code to set your password. Then sign in with your phone number.',
        ),
      );
    }
    final partTime = _draft.employment == Employment.partTime;
    return LimsScaffold(
      title: 'Apply to join',
      actions: [
        Semantics(
          button: true,
          label: 'Close',
          child: InkResponse(
            key: const ValueKey('apply.close'),
            onTap: _busy ? null : widget.onClose,
            child: const SizedBox.square(dimension: LimsTokens.touchTargetFlutter, child: Icon(Icons.close)),
          ),
        ),
      ],
      bottomNavigationBar: BottomActions(children: [
        if (_error != null) NoticeCard(tone: 'danger', text: _error!),
        LimsButton(key: const ValueKey('apply.send'), label: _busy ? 'Sending…' : 'Send application', onPressed: _busy ? null : _send),
      ]),
      body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
        LimsCard(
          title: 'About you',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            LimsTextField(
              key: const ValueKey('apply.name'),
              label: 'Full name',
              maxLength: 120,
              sensitive: true,
              onChanged: (v) => _draft.fullName = v,
              errorText: _problems['fullName'],
            ),
            LimsTextField(
              key: const ValueKey('apply.phone'),
              label: 'Mobile number (10 digits)',
              maxLength: 16,
              sensitive: true,
              keyboardType: TextInputType.phone,
              onChanged: (v) => _draft.phone = v,
              errorText: _problems['phone'],
            ),
            LimsTextField(
              key: const ValueKey('apply.email'),
              label: 'Email address',
              maxLength: 254,
              sensitive: true,
              keyboardType: TextInputType.emailAddress,
              onChanged: (v) => _draft.email = v,
              errorText: _problems['email'],
            ),
            LimsTextField(
              key: const ValueKey('apply.area'),
              label: 'Area you live in',
              maxLength: 120,
              sensitive: true,
              onChanged: (v) => _draft.area = v,
              errorText: _problems['area'],
            ),
          ]),
        ),
        const SizedBox(height: LimsTokens.space3),
        LimsCard(
          title: 'How you want to work',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _choice('Full time', Employment.fullTime, _draft.employment, (v) => _draft.employment = v),
            _choice('Part time', Employment.partTime, _draft.employment, (v) => _draft.employment = v),
            _problem('employment'),
            if (partTime) ...[
              const Divider(),
              Text('Shifts in a day', style: Theme.of(context).textTheme.titleSmall),
              _choice('Single shift', ShiftCount.single, _draft.shiftCount, (v) {
                _draft.shiftCount = v;
                if (_draft.slots.length > 1) _draft.slots.clear();
              }),
              _choice('Double shift', ShiftCount.double, _draft.shiftCount, (v) => _draft.shiftCount = v),
              _problem('shift'),
              const Divider(),
              Text('Time of day', style: Theme.of(context).textTheme.titleSmall),
              for (final slot in DaySlot.values)
                LimsListTile(
                  title: daySlotLabels[slot]!,
                  leading: Icon(_draft.slots.contains(slot) ? Icons.check_box : Icons.check_box_outline_blank),
                  onTap: _busy
                      ? null
                      : () => setState(() {
                            if (_draft.slots.remove(slot)) return;
                            // A single shift is one time of day: picking another replaces it.
                            if (_draft.shiftCount != ShiftCount.double) _draft.slots.clear();
                            if (_draft.slots.length < 2) _draft.slots.add(slot);
                          }),
                ),
              _problem('slots'),
            ],
          ]),
        ),
        const SizedBox(height: LimsTokens.space3),
        LimsCard(
          title: 'Documents',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Clear photos or PDF files, up to 2 MB each. Photos are made smaller before they are sent. Only the lab administrators can open them.'),
            const SizedBox(height: LimsTokens.space3),
            for (final kind in DocKind.values) _docs(kind),
          ]),
        ),
        const SizedBox(height: LimsTokens.space3),
        LimsCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            LimsListTile(
              key: const ValueKey('apply.declared'),
              title: 'My details and documents are true and my own.',
              leading: Icon(_draft.declared ? Icons.check_box : Icons.check_box_outline_blank),
              onTap: _busy ? null : () => setState(() => _draft.declared = !_draft.declared),
            ),
            _problem('declared'),
          ]),
        ),
      ]),
    );
  }
}
