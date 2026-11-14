// HC-T27 M12 Settings/About + sign-out (04-UI-UX §3.12; TRD §7.4 step 5). LD-140 (2026-11-13): lims_ui + tokens only.
// The screen only asks the injected `signOut`; the server calls and the local wipe belong to that function.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../outbox/domain/time_labels.dart';
import '../../visit/ui/save_once.dart' show FactRow, InlineNotice;
import '../domain/sign_out.dart';

const _dash = '—';
const _offlineText = 'Sign-out needs an internet connection. Connect to the internet and try again.';
const _unsyncedText = 'Sync first — some changes are not uploaded yet.';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.deviceId,
    required this.appVersion,
    required this.userDisplayName,
    required this.lastDownload,
    required this.lastUpload,
    required this.pendingCount,
    required this.signOut,
    required this.onSignedOut,
  });

  final String deviceId;
  final String appVersion;
  final String userDisplayName;
  final DateTime? lastDownload;
  final DateTime? lastUpload;
  final int pendingCount;
  final Future<SignOutResult> Function() signOut;
  final VoidCallback onSignedOut;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _busy = false;
  String? _refused;

  String _stamp(DateTime? d) => d == null ? _dash : '${formatDmy(d)} ${formatHm(d)}';

  String get _deviceTail {
    final id = widget.deviceId;
    return id.length > 8 ? id.substring(id.length - 8) : id;
  }

  Future<void> _signOut() async {
    final go = await LimsConfirmDialog.show(
      context,
      title: 'Sign out?',
      message: "Signing out erases today's visit list from this phone.",
      confirmLabel: 'Sign out',
    );
    if (go == null || !mounted) return;
    setState(() {
      _busy = true;
      _refused = null;
    });
    final SignOutResult result;
    try {
      result = await widget.signOut();
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _refused = _offlineText;
        });
      }
      return;
    }
    if (!mounted) return;
    if (result == SignOutResult.done) {
      widget.onSignedOut(); // stays busy: the session is gone, a second sign-out must not start
    } else {
      setState(() {
        _busy = false;
        _refused = _unsyncedText;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final n = widget.pendingCount;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Settings',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          FactRow(label: 'Device ID (last 8)', value: _deviceTail),
          FactRow(label: 'App version', value: widget.appVersion),
          FactRow(label: 'Signed in as', value: widget.userDisplayName),
          FactRow(label: 'Last download', value: _stamp(widget.lastDownload)),
          FactRow(label: 'Last upload', value: _stamp(widget.lastUpload)),
          const SizedBox(height: LimsTokens.space6),
          if (n > 0) InlineNotice(tone: 'warning', text: 'Sync first — $n ${n == 1 ? 'change is' : 'changes are'} not uploaded yet'),
          if (_refused != null) InlineNotice(tone: 'danger', text: _refused!),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Sign out', onPressed: n > 0 || _busy ? null : _signOut),
        ]),
      ),
    );
  }
}
