// A23 Settings (04-UI-UX A23; 03-APP-FLOW A23: E10, E11, E12, C2 logout; PRD US-EN-19.1/19.2, US-EN-23.3). LD-28: "Privacy policy" / "Terms of use" open in the system browser through
// externalUrlOpenerProvider, URLs from the flavour (build config); the tenant privacy URL is a second link under the lab name. LD-140: lims_ui widgets and tokens only.
// Reminder switch = INVERSE of reminders_opt_out. Delete = E12 behind a typed "DELETE" dialog, then the LOCAL session is wiped with expire() - C2 already revoked every session, so no logout call.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import '../auth/auth_providers.dart';
import 'settings_providers.dart';

const _generic = 'Something went wrong. Try again.';
const _confirmWord = 'DELETE';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key, this.onSignedOut});

  /// Called after the local session is gone (sign out or deletion); the host shows the sign-in flow.
  final VoidCallback? onSignedOut;

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  AccountState? _account;
  bool _loadFailed = false;
  bool _busy = false; // one request at a time: a toggle, a deletion or a sign out
  String? _notice;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final a = parseAccount(await ref.read(accountApiProvider).getMyAccount());
      if (mounted) setState(() { _account = a; _loadFailed = false; });
    } catch (_) {
      if (mounted) setState(() => _loadFailed = true);
    }
  }

  /// A request failed: say so in words; a stale version also re-reads E10 so the next try uses the server state.
  Future<void> _failed(Object e) async {
    if (mounted) setState(() => _notice = _generic);
    if (e is LimsException && e.code == LimsErrorCodes.commonVersionConflict) await _load();
  }

  Future<void> _toggle(bool remindersOn) async {
    final a = _account;
    if (a == null || _busy) return;
    setState(() { _busy = true; _notice = null; });
    try {
      final next = parseAccount(await ref.read(accountApiProvider).updateMyAccount(version: a.version, remindersOptOut: !remindersOn));
      if (mounted) setState(() => _account = next);
    } catch (e) {
      await _failed(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signOut() async {
    if (_busy) return;
    setState(() { _busy = true; _notice = null; });
    try {
      await ref.read(sessionControllerProvider).logout();
    } catch (_) {
      // the local session is wiped even when the server call fails
    }
    widget.onSignedOut?.call();
  }

  Future<void> _delete() async {
    final a = _account;
    if (a == null || _busy) return;
    final confirmed = await showDialog<bool>(context: context, builder: (_) => _DeleteDialog(lab: ref.read(flavourProvider).displayName));
    if (confirmed != true || !mounted) return;
    setState(() { _busy = true; _notice = null; });
    try {
      await ref.read(accountApiProvider).deleteMyAccount(version: a.version);
    } catch (e) {
      await _failed(e);
      if (mounted) setState(() => _busy = false);
      return;
    }
    await ref.read(sessionControllerProvider).expire();
    widget.onSignedOut?.call();
  }

  void _open(String? url) {
    final uri = url == null || url.isEmpty ? null : Uri.tryParse(url);
    if (uri != null) ref.read(externalUrlOpenerProvider)(uri);
  }

  Widget _link(String label, String? url) =>
      url == null || url.isEmpty ? const SizedBox.shrink() : TextButton(onPressed: () => _open(url), child: Text(label));

  @override
  Widget build(BuildContext context) {
    final flavour = ref.watch(flavourProvider);
    final a = _account;
    return LimsScaffold(
      title: 'Settings',
      body: _loadFailed
          ? LimsErrorState(title: 'Something went wrong', message: 'We could not load your settings.', onRetry: () { setState(() => _loadFailed = false); _load(); })
          : a == null
              ? const LimsLoading()
              : ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
                  if (_notice != null) _Notice(_notice!),
                  LimsCard(
                    title: 'Reminders',
                    child: SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Reminder messages by SMS'),
                      value: !a.remindersOptOut,
                      onChanged: _busy ? null : _toggle,
                    ),
                  ),
                  const LimsListTile(title: 'App lock', subtitle: 'Your device screen lock is required to open this app.', leading: Icon(Icons.lock_outline)),
                  if (flavour.tenantPrivacyUrl != null && flavour.tenantPrivacyUrl!.isNotEmpty)
                    LimsCard(title: flavour.displayName, child: Align(alignment: AlignmentDirectional.centerStart, child: _link('Privacy policy', flavour.tenantPrivacyUrl))),
                  Wrap(alignment: WrapAlignment.center, children: [
                    _link('Privacy policy', flavour.privacyUrl),
                    _link('Terms of use', flavour.termsUrl),
                  ]),
                  const SizedBox(height: LimsTokens.space4),
                  LimsButton(label: 'Sign out', icon: Icons.logout, secondary: true, onPressed: _busy ? null : _signOut),
                  const SizedBox(height: LimsTokens.space2),
                  LimsButton(label: 'Delete my app account', icon: Icons.delete_outline, secondary: true, onPressed: _busy ? null : _delete),
                ]),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = limsTone('danger');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: LimsTokens.space2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.error_outline, color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(message, style: TextStyle(color: c.fg))),
        ]),
      ),
    );
  }
}

/// Typed-confirmation danger dialog (04-UI-UX A23): Confirm stays disabled until the text is exactly DELETE. LimsConfirmDialog has no text-confirm option, so it is composed here.
class _DeleteDialog extends StatefulWidget {
  const _DeleteDialog({required this.lab});

  final String lab;

  @override
  State<_DeleteDialog> createState() => _DeleteDialogState();
}

class _DeleteDialogState extends State<_DeleteDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Delete your app account?'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('This deletes your app account and removes all profiles from this app.'),
            const SizedBox(height: LimsTokens.space2),
            Text('Your records at ${widget.lab} are not deleted.'),
            const SizedBox(height: LimsTokens.space4),
            LimsTextField(label: 'Type $_confirmWord to confirm', maxLength: 16, controller: _text, onChanged: (_) => setState(() {})),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            onPressed: _text.text == _confirmWord ? () => Navigator.of(context).pop(true) : null,
            child: const Text('Delete account'),
          ),
        ],
      );
}
