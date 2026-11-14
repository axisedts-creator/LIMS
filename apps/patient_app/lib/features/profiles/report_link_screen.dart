// A8 Add from report message (E15; 04-UI-UX A8; US-EN-04.1-.3, US-EN-04.5). The pasted link carries a secret token: it lives in the field only, goes in the
// E15 body only, and is never logged, stored, copied or echoed back. The phone checks the portal origin first (the server re-checks); every server
// refusal reads like A7 (profile_copy.dart). LD-140: lims_ui widgets and tokens only; one primary button.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import 'profile_copy.dart';
import 'profiles_providers.dart';

class ReportLinkScreen extends ConsumerStatefulWidget {
  const ReportLinkScreen({super.key, this.onAdded});

  /// Called with the profile id once E15 succeeds (201 and 200 "already linked" alike).
  final void Function(String profileId)? onAdded;

  @override
  ConsumerState<ReportLinkScreen> createState() => _ReportLinkScreenState();
}

class _ReportLinkScreenState extends ConsumerState<ReportLinkScreen> {
  final _controller = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  String get _link => _controller.text.trim();

  /// `{portalOrigin}/r/` then a token. The origin must end at "/" so a longer host or a userinfo trick does not pass.
  bool get _valid {
    final prefix = '${ref.read(flavourProvider).portalOrigin}/r/';
    final link = _link;
    return link.startsWith(prefix) && link.length > prefix.length && !link.contains(RegExp(r'\s'));
  }

  Future<void> _submit() async {
    if (_busy || !_valid) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final id = profileIdOf(await ref.read(profilesApiProvider).redeemReportLink(linkUrl: _link));
      if (!mounted) return;
      setState(() => _busy = false);
      LimsSnackbar.show(context, 'Profile added', tone: 'success');
      widget.onAdded?.call(id);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = linkFailureCopy(e, validationIsInvalid: true);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final showShapeError = _link.isNotEmpty && !_valid;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Report message',
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(LimsTokens.space4),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(
              "Paste the report link from the SMS or WhatsApp message the lab sent to this phone. You'll see reports from that one onwards. For older reports, ask the lab for an app code.",
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: LimsTokens.space4),
            // ponytail: LimsTextField is single-line (no multiline option yet); a long link scrolls inside the field.
            LimsTextField(
              label: 'Link',
              maxLength: 2000,
              sensitive: true,
              controller: _controller,
              keyboardType: TextInputType.url,
              errorText: showShapeError ? 'Paste the whole link from the message.' : null,
              onChanged: (_) => setState(() => _error = null),
            ),
            if (_error != null) ProfileNotice(_error!),
            const SizedBox(height: LimsTokens.space4),
            if (_busy) const LimsLoading(label: 'Checking link'),
            LimsButton(label: 'Add profile', onPressed: _busy || !_valid ? null : _submit),
          ]),
        ),
      ),
    );
  }
}
