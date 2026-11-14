// A7 Redeem lab code (E14; 04-UI-UX A7; US-EN-03.2-.4, US-EN-04.1-.3). The code is a secret: it lives in the field only, goes in the E14 body only,
// and is never logged, stored, copied or echoed back. Every 422 reads the same (profile_copy.dart). LD-140: lims_ui widgets and tokens only; one primary button.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import 'profile_copy.dart';
import 'profiles_providers.dart';

const _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // TRD §4.3
const _symbols = 10;

class LinkCodeScreen extends ConsumerStatefulWidget {
  const LinkCodeScreen({super.key, this.onAdded});

  /// Called with the profile id once E14 succeeds (201 and 200 "already linked" alike).
  final void Function(String profileId)? onAdded;

  @override
  ConsumerState<LinkCodeScreen> createState() => _LinkCodeScreenState();
}

class _LinkCodeScreenState extends ConsumerState<LinkCodeScreen> {
  String _code = ''; // 10 normalised symbols, no dash
  String? _error;
  bool _busy = false;

  String get _grouped => '${_code.substring(0, 5)}-${_code.substring(5)}';

  Future<void> _submit() async {
    if (_busy || _code.length != _symbols) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final id = profileIdOf(await ref.read(profilesApiProvider).redeemLinkCode(code: _grouped));
      if (!mounted) return;
      setState(() => _busy = false);
      LimsSnackbar.show(context, 'Profile added', tone: 'success');
      widget.onAdded?.call(id);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = linkFailureCopy(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Lab code',
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(LimsTokens.space4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Ask the front desk for an app code. It works once, on this phone number only.', style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: LimsTokens.space4),
              LimsCodeField(
                label: 'Code',
                alphabet: _crockford,
                onChanged: (v) => setState(() {
                  _code = v;
                  _error = null;
                }),
              ),
              if (_error != null) ProfileNotice(_error!),
              const SizedBox(height: LimsTokens.space4),
              if (_busy) const LimsLoading(label: 'Checking code'),
              LimsButton(label: 'Add profile', onPressed: _busy || _code.length != _symbols ? null : _submit),
            ]),
          ),
        ),
      );
}
