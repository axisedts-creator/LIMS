// Full-page device states that block normal use (C17 03-APP-FLOW §1.4 device machine, §2.4 wipe copy, 04-UI-UX §3.1 login
// copy). The web "Phlebotomy phones" page requests a wipe; the phone uploads pending changes first, then erases.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

enum DeviceNotice { wipeRequested, wiped, updateRequired, noScreenLock, rooted }

class DeviceNoticeScreen extends StatelessWidget {
  const DeviceNoticeScreen({
    super.key,
    required this.kind,
    this.pendingChanges = 0,
    this.onPrimary,
    this.uploading = false,
  });

  final DeviceNotice kind;

  /// wipeRequested: how many changes still have to upload before the erase.
  final int pendingChanges;
  final VoidCallback? onPrimary;

  /// wipeRequested: upload in progress.
  final bool uploading;

  (String, String, IconData, String, String?) get _copy => switch (kind) {
    DeviceNotice.wipeRequested => (
      'This phone will be erased',
      'The centre asked for this phone to be wiped. Your unsent changes upload first, then all home-collection data on this phone is erased.',
      Icons.phonelink_erase,
      'warning',
      uploading ? 'Uploading…' : 'Upload now',
    ),
    DeviceNotice.wiped => (
      'This phone was erased',
      'All home-collection data was removed by the centre. Sign in again to set this phone up.',
      Icons.delete_sweep_outlined,
      'neutral',
      'Sign in again',
    ),
    DeviceNotice.updateRequired => (
      'Update the app to continue',
      'This version is older than the centre allows. Update, then open the app again.',
      Icons.system_update_alt,
      'info',
      'Open the app store',
    ),
    DeviceNotice.noScreenLock => (
      'Set a screen lock first',
      'Set a screen lock (PIN, pattern or fingerprint) on this phone first.',
      Icons.lock_outline,
      'warning',
      'Open phone settings',
    ),
    DeviceNotice.rooted => (
      "This phone can't be used",
      "This phone can't be used for home collection.",
      Icons.gpp_bad_outlined,
      'danger',
      null,
    ),
  };

  @override
  Widget build(BuildContext context) {
    final (title, text, icon, tone, action) = _copy;
    final c = limsTone(tone);
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: Scaffold(
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            SliverFillRemaining(
              hasScrollBody: false,
              child: Padding(
                padding: const EdgeInsets.all(LimsTokens.space6),
                child: Column(
                  children: [
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.all(LimsTokens.space5),
                      decoration: BoxDecoration(
                        color: c.bg,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(icon, size: LimsTokens.space10, color: c.fg),
                    ),
                    const SizedBox(height: LimsTokens.space5),
                    Semantics(
                      header: true,
                      child: Text(
                        title,
                        textAlign: TextAlign.center,
                        style: t.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    const SizedBox(height: LimsTokens.space2),
                    Text(
                      text,
                      textAlign: TextAlign.center,
                      style: t.bodyLarge?.copyWith(
                        color: LimsTokens.colorNeutral600,
                      ),
                    ),
                    if (kind == DeviceNotice.wipeRequested) ...[
                      const SizedBox(height: LimsTokens.space4),
                      PhleboNotice(
                        tone: pendingChanges > 0 ? 'warning' : 'success',
                        text: pendingChanges > 0
                            ? '$pendingChanges ${pendingChanges == 1 ? 'change is' : 'changes are'} not uploaded yet. Connect to the internet to keep them.'
                            : 'Everything is uploaded. The phone will erase itself now.',
                      ),
                    ],
                    const Spacer(),
                    if (action != null)
                      SizedBox(
                        width: double.infinity,
                        child: LimsButton(
                          label: action,
                          onPressed: uploading ? null : onPrimary,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      ),
    );
  }
}
