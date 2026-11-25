// "My ID card": what the patient checks at the door. The patient app tells them to "ask for this staff ID and confirm the
// name before sharing a sample", so the phlebotomist needs one big, clear place to show both. Display only, works offline.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../domain/staff_profile.dart';

class IdCardScreen extends StatelessWidget {
  const IdCardScreen({super.key, required this.profile});

  final StaffProfile profile;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'My ID card',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          PhleboHero(
            child: Column(children: [
              const SizedBox(height: LimsTokens.space2),
              PhleboAvatar(name: profile.displayName, size: LimsTokens.space16 + LimsTokens.space6, onDark: true),
              const SizedBox(height: LimsTokens.space3),
              Text(profile.displayName, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w700)),
              Text('Phlebotomist', style: t.bodyLarge?.copyWith(color: LimsTokens.colorAccentSubtle)),
              const SizedBox(height: LimsTokens.space4),
              Semantics(
                label: 'Staff ID ${profile.staffId}',
                excludeSemantics: true,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: LimsTokens.space4),
                  decoration: const BoxDecoration(color: LimsTokens.colorNeutral0, borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusLg))),
                  child: Column(children: [
                    Text('STAFF ID', style: t.labelSmall?.copyWith(color: LimsTokens.colorNeutral600, fontWeight: FontWeight.w700, letterSpacing: 1)),
                    Text(profile.staffId, style: t.headlineMedium?.copyWith(color: LimsTokens.colorNeutral900, fontWeight: FontWeight.w700, fontFamily: LimsTheme.monoFamily)),
                  ]),
                ),
              ),
              const SizedBox(height: LimsTokens.space3),
              Text(profile.labName, style: t.bodyMedium?.copyWith(color: LimsTokens.colorAccentSubtle)),
              const SizedBox(height: LimsTokens.space2),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          const LimsCard(
            title: 'What the patient will check',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _CheckLine('The staff ID above matches the one in their booking.'),
              _CheckLine('The name on this card is the name of the person at the door.'),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          const PhleboNotice(
            tone: 'info',
            title: 'Never hand over your phone',
            text: 'Show the card, then take it back. Patient details stay on your screen only.',
          ),
        ]),
      ),
    );
  }
}

class _CheckLine extends StatelessWidget {
  const _CheckLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Icon(Icons.check, color: LimsTokens.colorToneSuccessFg, size: LimsTokens.space5),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(text)),
        ]),
      );
}
