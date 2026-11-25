// Location sharing: when the phone sends its position and what the phlebotomist can do about it. The patient app shows
// "Live location starts when they set off" and ends sharing on arrival; this is the matching explanation on the phone.
// The permission itself belongs to the OS: the screen reports its state and hands off to the phone's settings.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

enum LocationPermission { granted, denied, serviceOff }

class LocationScreen extends StatelessWidget {
  const LocationScreen({super.key, required this.permission, required this.onOpenPhoneSettings, this.gpsPointEnabled = true});

  final LocationPermission permission;
  final VoidCallback onOpenPhoneSettings;

  /// Centre setting "Capture GPS point": one point at arrival.
  final bool gpsPointEnabled;

  @override
  Widget build(BuildContext context) {
    final ok = permission == LocationPermission.granted;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Location sharing',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          PhleboNotice(
            tone: ok ? 'success' : 'warning',
            title: switch (permission) {
              LocationPermission.granted => 'Location is on',
              LocationPermission.denied => 'Location permission is off',
              LocationPermission.serviceOff => 'Location service is off',
            },
            text: ok
                ? 'The app can share your position while you are on the way to a patient.'
                : 'Patients will not see where you are, and the centre cannot see your arrival point, until you turn location on.',
            action: ok ? null : onOpenPhoneSettings,
            actionLabel: ok ? null : 'Open phone settings',
          ),
          const SizedBox(height: LimsTokens.space3),
          const LimsCard(
            title: 'When your position is shared',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _Step(icon: Icons.navigation_outlined, title: 'You tap "On my way"', text: 'The patient sees "On the way" and a live estimate.'),
              _Step(icon: Icons.flag_outlined, title: 'You tap "I\'ve arrived"', text: 'Sharing stops. The patient is told you are at the address.'),
              _Step(icon: Icons.lock_outline, title: 'Never at other times', text: 'Between visits and after arrival your position is not shared.'),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Arrival point',
            child: Text(gpsPointEnabled ? 'One position is saved with "I\'ve arrived" so the centre can confirm the visit.' : 'The centre has turned the arrival point off.'),
          ),
        ]),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.icon, required this.title, required this.text});

  final IconData icon;
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: LimsTokens.space2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        PhleboIconTile(icon),
        const SizedBox(width: LimsTokens.space3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
            Text(text, style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
          ]),
        ),
      ]),
    );
  }
}
