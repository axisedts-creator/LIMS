// A22 New message (04-UI-UX A22; US-EN-18.1). Topic (coded set enquiry_categories, required), About (one of the caller's profiles, optional), Subject <= 120 and Message <= 2000 (both required, with a counter).
// [Send] stays disabled until Topic, Subject and Message are filled and while E49 runs (one enquiry per tap). A failure keeps the typed text. PHI screen (LimsSecureScreen, REQ-SEC-109);
// the text lives in the controllers only: no store, no log. LD-140: lims_ui widgets and tokens only; one primary button per page.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../notifications/notifications_providers.dart' show profileNamesProvider;
import '../profiles/profile_copy.dart' show ProfileNotice;
import 'enquiries_providers.dart';
import 'enquiry_copy.dart';

class NewEnquiryScreen extends ConsumerStatefulWidget {
  const NewEnquiryScreen({super.key, this.onCreated});

  final void Function(String enquiryId)? onCreated;

  @override
  ConsumerState<NewEnquiryScreen> createState() => _NewEnquiryScreenState();
}

class _NewEnquiryScreenState extends ConsumerState<NewEnquiryScreen> {
  final _subject = TextEditingController();
  final _message = TextEditingController();
  String? _topic;
  String? _profileId;
  bool _busy = false;
  String? _notice;

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    super.dispose();
  }

  bool get _ready => _topic != null && _subject.text.trim().isNotEmpty && _message.text.trim().isNotEmpty;

  Future<void> _send() async {
    if (_busy || !_ready) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final res = await ref.read(enquiriesApiProvider).createMyEnquiry(categoryCode: _topic!, subject: _subject.text, message: _message.text, profileId: _profileId);
      ref.invalidate(enquiriesProvider);
      final id = res is Map && res['id'] is String ? res['id'] as String : null;
      if (!mounted) return;
      setState(() => _busy = false);
      if (id != null) widget.onCreated?.call(id);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = sendFailure(e);
      });
    }
  }

  Widget _form(List<EnquiryCategory> topics, Map<String, String> names) {
    const gap = SizedBox(height: LimsTokens.space4);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _PickField(
          label: 'Topic',
          shown: [for (final t in topics) if (t.code == _topic) t.display].firstOrNull,
          options: [for (final t in topics) (value: t.code, label: t.display)],
          onPicked: (v) => setState(() => _topic = v),
        ),
        gap,
        _PickField(
          label: 'About',
          shown: _profileId == null ? null : names[_profileId],
          options: [for (final e in names.entries) (value: e.key, label: e.value)],
          noneLabel: 'No one in particular',
          onPicked: (v) => setState(() => _profileId = v),
        ),
        gap,
        LimsTextField(label: 'Subject', maxLength: 120, sensitive: true, controller: _subject, onChanged: (_) => setState(() {})),
        gap,
        LimsTextField(label: 'Message', maxLength: 2000, sensitive: true, controller: _message, onChanged: (_) => setState(() {})),
        if (_notice != null) ProfileNotice(_notice!),
        gap,
        if (_busy) const LimsLoading(label: 'Sending'),
        LimsButton(label: 'Send', onPressed: _ready && !_busy ? _send : null),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final topics = ref.watch(enquiryCategoriesProvider);
    final names = ref.watch(profileNamesProvider).value ?? const <String, String>{};
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'New message',
        body: topics.when(
          loading: () => const LimsLoading(),
          error: (_, __) => LimsErrorState(title: 'Could not load the form', message: 'Check your connection and try again.', onRetry: () => ref.invalidate(enquiryCategoriesProvider)),
          data: (t) => _form(t, names),
        ),
      ),
    );
  }
}

typedef _Option = ({String value, String label});

/// A labelled field that opens a bottom sheet of options (no coded value is typed by hand). `noneLabel` adds a clearing row for optional fields.
class _PickField extends StatelessWidget {
  const _PickField({required this.label, required this.shown, required this.options, required this.onPicked, this.noneLabel});

  final String label;
  final String? shown;
  final List<_Option> options;
  final String? noneLabel;
  final void Function(String?) onPicked;

  Future<void> _open(BuildContext context) async {
    final picked = await showModalBottomSheet<({String? value})>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          if (noneLabel != null) ListTile(title: Text(noneLabel!), onTap: () => Navigator.pop(ctx, (value: null))),
          for (final o in options) ListTile(title: Text(o.label), onTap: () => Navigator.pop(ctx, (value: o.value))),
        ]),
      ),
    );
    if (picked != null) onPicked(picked.value);
  }

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        child: InkWell(
          onTap: () => _open(context),
          child: InputDecorator(
            decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.arrow_drop_down)),
            isEmpty: shown == null,
            child: shown == null ? null : Text(shown!),
          ),
        ),
      );
}
