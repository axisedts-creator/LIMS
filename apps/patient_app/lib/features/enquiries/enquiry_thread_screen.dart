// A22 Thread (04-UI-UX A22; US-EN-18.2, 18.4). Bubbles: the patient's right, the lab's left, each with a timestamp; plain text only (markup is shown, never interpreted).
// Reply = E51 with If-Match = the thread version. Closed (loaded, or 409 `engagement.enquiry_invalid_transition`) -> "This conversation is closed." and no reply box. 409 `common.version_conflict`
// -> the thread is fetched again and the typed text stays. PHI screen (LimsSecureScreen, REQ-SEC-109); text lives in provider / controller state only. LD-140: lims_ui widgets and tokens only.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../profiles/profile_copy.dart' show ProfileNotice;
import 'enquiries_providers.dart';
import 'enquiry_copy.dart';

class EnquiryThreadScreen extends ConsumerStatefulWidget {
  const EnquiryThreadScreen({super.key, required this.enquiryId});

  final String enquiryId;

  @override
  ConsumerState<EnquiryThreadScreen> createState() => _EnquiryThreadScreenState();
}

class _EnquiryThreadScreenState extends ConsumerState<EnquiryThreadScreen> {
  final _reply = TextEditingController();
  EnquiryThread? _local; // the thread returned by our own reply, until the next fetch
  bool _closed = false;
  bool _busy = false;
  String? _notice;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _send(EnquiryThread t) async {
    final text = _reply.text;
    if (_busy || text.trim().isEmpty) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final res = await ref.read(enquiriesApiProvider).replyMyEnquiry(id: widget.enquiryId, message: text, version: t.summary.version);
      final next = parseEnquiryThread(res);
      ref.invalidate(enquiriesProvider);
      if (!mounted) return;
      setState(() {
        _local = next;
        _reply.clear();
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      final code = e is LimsException ? e.code : null;
      if (code == 'common.version_conflict') {
        setState(() {
          _local = null;
          _busy = false;
        });
        ref.invalidate(enquiryThreadProvider(widget.enquiryId)); // fetch again; the typed text stays
      } else {
        setState(() {
          _busy = false;
          if (code == 'engagement.enquiry_invalid_transition') {
            _closed = true;
          } else {
            _notice = sendFailure(e);
          }
        });
      }
    }
  }

  Widget _body(EnquiryThread t) {
    final closed = _closed || t.summary.isClosed;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: Row(children: [Expanded(child: Text(t.summary.subject, style: Theme.of(context).textTheme.titleMedium)), const SizedBox(width: LimsTokens.space2), EnquiryStatusChip(closed ? 'closed' : t.summary.status)]),
      ),
      Expanded(
        child: ListView(
          padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space4),
          children: [for (final m in t.messages) _Bubble(m)],
        ),
      ),
      Padding(
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: closed
            ? Row(children: [const Icon(Icons.lock_outline), const SizedBox(width: LimsTokens.space2), Expanded(child: Text(closedNotice, style: Theme.of(context).textTheme.bodyMedium))])
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                LimsTextField(label: 'Reply', maxLength: 2000, sensitive: true, controller: _reply, onChanged: (_) => setState(() {})),
                if (_notice != null) ProfileNotice(_notice!),
                const SizedBox(height: LimsTokens.space2),
                LimsButton(label: 'Send', onPressed: _reply.text.trim().isNotEmpty && !_busy ? () => _send(t) : null),
              ]),
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(enquiryThreadProvider(widget.enquiryId));
    final t = _local ?? async.value;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Message',
        body: t != null
            ? _body(t)
            : async.hasError
                ? LimsErrorState(title: 'Could not load this conversation', message: 'Check your connection and try again.', onRetry: () => ref.invalidate(enquiryThreadProvider(widget.enquiryId)))
                : const LimsLoading(),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.m);

  final EnquiryMessage m;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Align(
      alignment: m.isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
        padding: const EdgeInsets.all(LimsTokens.space3),
        constraints: const BoxConstraints(maxWidth: 480),
        decoration: BoxDecoration(color: m.isMine ? scheme.primaryContainer : scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(LimsTokens.radiusLg)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(m.body, style: text.bodyMedium),
          const SizedBox(height: LimsTokens.space1),
          Text('${m.isMine ? 'You' : 'Lab'} · ${whenText(m.createdAt)}', style: text.bodySmall),
        ]),
      ),
    );
  }
}
