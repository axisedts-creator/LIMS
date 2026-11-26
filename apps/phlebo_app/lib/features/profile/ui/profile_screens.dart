// PHLEBO-UI-FULL-1 G01-G03. Weekly numbers, the patient-checkable staff ID and live location sharing have no contract
// (.orchestra/cr/PHLEBO-UI-FULL-1.md): they are named as not available, never filled with sample data.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';
import '../../outbox/domain/sync_summary.dart';
import '../../outbox/domain/time_labels.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({
    super.key,
    required this.name,
    required this.sync,
    required this.syncing,
    required this.onSync,
    required this.onIdCard,
    required this.onHandover,
    required this.onOutbox,
    required this.onLocation,
    required this.onHelp,
    required this.onSettings,
  });

  final String name;
  final SyncSummary sync;
  final bool syncing;
  final VoidCallback onSync, onIdCard, onHandover, onOutbox, onLocation, onHelp, onSettings;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final last = sync.lastUpload;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Profile',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          HeroCard(
            child: Row(children: [
              PersonAvatar(name: name),
              const SizedBox(width: LimsTokens.space3),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(name, style: t.titleLarge?.copyWith(color: LimsTokens.colorAccentFg)),
                  const Text('Phlebotomist'),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              LimsListTile(
                leading: IconBadge(icon: sync.waiting > 0 ? Icons.schedule : Icons.cloud_done_outlined),
                title: sync.waiting > 0 ? '${sync.waiting} waiting to upload' : 'Everything is uploaded',
                subtitle: 'Last upload ${last == null ? '—' : formatHm(last)}',
              ),
              LimsButton(label: syncing ? 'Syncing…' : 'Sync now', secondary: true, onPressed: syncing ? null : onSync),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            child: Column(children: [
              MenuRow(icon: Icons.badge_outlined, title: 'My ID card', subtitle: 'Show the patient who you are', onTap: onIdCard),
              MenuRow(icon: Icons.inventory_2_outlined, title: 'Handover', subtitle: 'Give tubes to the centre', onTap: onHandover),
              MenuRow(icon: Icons.outbox_outlined, title: 'Outbox', subtitle: 'Changes waiting to upload', onTap: onOutbox),
              MenuRow(icon: Icons.my_location, title: 'Location', subtitle: 'When your position is saved', onTap: onLocation),
              MenuRow(icon: Icons.help_outline, title: 'Help & support', subtitle: 'FAQs and what to do', onTap: onHelp),
              MenuRow(icon: Icons.settings_outlined, title: 'Settings and sign out', subtitle: 'Phone details, app version', onTap: onSettings),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          const NoticeCard(tone: 'info', text: 'Weekly collection numbers are not available in the app yet.'),
        ]),
      ),
    );
  }
}

/// G02.
class IdCardScreen extends StatelessWidget {
  const IdCardScreen({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'My ID card',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          HeroCard(
            child: SizedBox(
              width: double.infinity,
              child: Column(children: [
                PersonAvatar(name: name),
                const SizedBox(height: LimsTokens.space3),
                Text(name, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(color: LimsTokens.colorAccentFg)),
                const Text('Phlebotomist'),
              ]),
            ),
          ),
          const SizedBox(height: LimsTokens.space3),
          const NoticeCard(
            tone: 'warning',
            title: 'Staff ID is not available here yet',
            text: 'If the patient asks for a staff ID, show the ID card your lab issued to you.',
          ),
          const SizedBox(height: LimsTokens.space3),
          const NoticeCard(tone: 'info', title: 'Never hand over your phone', text: 'Show the screen, then take it back.'),
        ]),
      ),
    );
  }
}

/// G03 / G03b. [captureOn] is the centre's setting; [allowed] is this phone's permission and location service.
class LocationScreen extends StatelessWidget {
  const LocationScreen({super.key, required this.captureOn, required this.allowed, required this.onOpenSettings});

  final bool captureOn, allowed;
  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Location',
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            if (!captureOn)
              const NoticeCard(tone: 'neutral', title: 'Your position is not saved', text: 'The centre has position capture switched off.')
            else if (allowed)
              const NoticeCard(tone: 'success', title: 'Location is on', text: 'One position can be saved with a visit step.')
            else
              NoticeCard(
                tone: 'warning',
                title: 'Location is off for this app',
                text: 'Visit steps are saved without a position until you turn location on.',
                action: LimsButton(label: 'Open phone settings', secondary: true, onPressed: onOpenSettings),
              ),
            const SizedBox(height: LimsTokens.space3),
            const LimsCard(
              title: 'When a position is saved',
              child: Text('Only when the centre has switched it on, and only one point when you record that you arrived, '
                  'collected a tube, or could not do the visit. Never between visits and never in the background.'),
            ),
            const SizedBox(height: LimsTokens.space3),
            const NoticeCard(tone: 'info', text: 'Sharing your live position with the patient is not available yet.'),
          ]),
        ),
      );
}
