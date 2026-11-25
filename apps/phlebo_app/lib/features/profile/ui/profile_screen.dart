// Profile tab (board M5 "Profile"): who is signed in, this week's numbers, sync, then the list of everything else.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../../outbox/domain/sync_summary.dart';
import '../../outbox/domain/time_labels.dart';
import '../domain/staff_profile.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({
    super.key,
    required this.profile,
    required this.sync,
    required this.onSyncNow,
    required this.onOpenIdCard,
    required this.onOpenHandover,
    required this.onOpenOutbox,
    required this.onOpenLocation,
    required this.onOpenHelp,
    required this.onOpenSettings,
    this.syncing = false,
    this.offline = false,
  });

  final StaffProfile profile;
  final SyncSummary sync;
  final VoidCallback onSyncNow;
  final VoidCallback onOpenIdCard;
  final VoidCallback onOpenHandover;
  final VoidCallback onOpenOutbox;
  final VoidCallback onOpenLocation;
  final VoidCallback onOpenHelp;
  final VoidCallback onOpenSettings;
  final bool syncing;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final waiting = sync.waiting;
    final last = sync.lastUpload;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Profile',
        offlineBanner: offline ? const LimsOfflineBanner() : null,
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          PhleboHero(
            child: Row(children: [
              PhleboAvatar(name: profile.displayName, size: LimsTokens.space16, onDark: true),
              const SizedBox(width: LimsTokens.space4),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(profile.displayName, style: t.titleLarge?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w700)),
                  Text('Phlebotomist · ${profile.staffId}', style: t.bodyMedium?.copyWith(color: LimsTokens.colorAccentSubtle)),
                  Text(profile.labName, style: t.bodySmall?.copyWith(color: LimsTokens.colorAccentSubtle)),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          Row(children: [
            Expanded(child: PhleboStat(value: '${profile.weekCollections}', label: 'Collections this week')),
            const SizedBox(width: LimsTokens.space2),
            Expanded(child: PhleboStat(value: '${profile.onTimePercent}%', label: 'On-time rate')),
            const SizedBox(width: LimsTokens.space2),
            Expanded(child: PhleboStat(value: '${profile.rejectedSamples}', label: 'Rejected samples', tone: profile.rejectedSamples > 0 ? 'warning' : null)),
          ]),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            child: Row(children: [
              PhleboIconTile(waiting > 0 ? Icons.schedule : Icons.cloud_done_outlined, tone: waiting > 0 ? 'warning' : 'success'),
              const SizedBox(width: LimsTokens.space3),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(waiting > 0 ? '$waiting ${waiting == 1 ? 'change' : 'changes'} waiting to upload' : 'Everything is uploaded', style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                  Text(last == null ? 'No upload yet on this phone' : 'Last upload ${formatHm(last)}', style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
                ]),
              ),
              LimsButton(label: syncing ? 'Syncing…' : 'Sync now', secondary: true, onPressed: syncing || offline ? null : onSyncNow),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          PhleboListCard(children: [
            PhleboRow(leading: const PhleboIconTile(Icons.badge_outlined), title: 'My ID card', subtitle: 'Show the patient who you are', onTap: onOpenIdCard),
            PhleboRow(leading: const PhleboIconTile(Icons.inventory_2_outlined), title: 'Handover', subtitle: 'Give tubes to the centre', onTap: onOpenHandover),
            PhleboRow(leading: const PhleboIconTile(Icons.outbox_outlined), title: 'Outbox', subtitle: 'Changes waiting to upload', onTap: onOpenOutbox),
            PhleboRow(leading: const PhleboIconTile(Icons.my_location_outlined), title: 'Location sharing', subtitle: 'When your position is shared', onTap: onOpenLocation),
            PhleboRow(leading: const PhleboIconTile(Icons.help_outline), title: 'Help & support', subtitle: 'FAQs, contact dispatch, report a problem', onTap: onOpenHelp),
            PhleboRow(leading: const PhleboIconTile(Icons.settings_outlined), title: 'Settings and sign out', subtitle: 'Phone details, app version', onTap: onOpenSettings),
          ]),
        ]),
      ),
    );
  }
}
