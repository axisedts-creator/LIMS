// Travel card on the visit screen: the phone's side of the patient app's "Track collection" (stages Assigned > On the way >
// Arrived > Collected; location states live / delayed / no signal / off). Display only: the host decides what "live" means.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';
import '../domain/travel_models.dart';

class TravelCard extends StatelessWidget {
  const TravelCard({
    super.key,
    required this.state,
    this.onOpenLocationSettings,
    this.arrived = false,
  });

  final TravelState state;
  final VoidCallback? onOpenLocationSettings;

  /// The visit already has "I've arrived" (stage 3 reached).
  final bool arrived;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final stage = arrived ? 2 : (state.onTheWay ? 1 : 0);
    return LimsCard(
      title: 'Travel',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Stages(current: stage),
          const SizedBox(height: LimsTokens.space3),
          if (!state.onTheWay && !arrived)
            const PhleboNotice(
              tone: 'info',
              icon: Icons.navigation_outlined,
              title: 'Tap "On my way" when you leave',
              text: 'The patient is told you are coming and sees a live estimate until you arrive.',
            )
          else if (state.onTheWay && !arrived) ...[
            if (state.etaMin != null)
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.end,
                spacing: LimsTokens.space2,
                children: [
                  Text(
                    '${state.etaMin} min',
                    style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  Text(
                    state.distanceKm == null ? 'away' : 'away · ${state.distanceKm} km',
                    style: t.bodyMedium?.copyWith(color: LimsTokens.colorNeutral600),
                  ),
                ],
              ),
            const SizedBox(height: LimsTokens.space2),
            _Sharing(
              state: state,
              onOpenLocationSettings: onOpenLocationSettings,
            ),
          ] else
            const PhleboNotice(
              tone: 'success',
              text: 'You are at the address. Location sharing has ended.',
            ),
        ],
      ),
    );
  }
}

class _Stages extends StatelessWidget {
  const _Stages({required this.current});

  final int current;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    // stage 0 = assigned, 1 = on the way, 2 = arrived. "Assigned" is always done once the visit is on the list.
    const all = ['Assigned', 'On the way', 'Arrived', 'Collected'];
    Color line(bool lit) =>
        lit ? LimsTokens.colorAccentDefault : LimsTokens.colorToneNeutralBorder;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < all.length; i++)
          Expanded(
            child: Semantics(
              label:
                  '${all[i]}, ${i < current ? 'done' : (i == current ? 'current step' : 'not started')}',
              excludeSemantics: true,
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Container(
                          height: LimsTokens.space0x5,
                          color: i == 0
                              ? LimsTokens.colorNeutral0
                              : line(i <= current),
                        ),
                      ),
                      Icon(
                        i < current
                            ? Icons.check_circle
                            : (i == current
                                  ? Icons.radio_button_checked
                                  : Icons.radio_button_unchecked),
                        color: i <= current
                            ? LimsTokens.colorAccentDefault
                            : LimsTokens.colorNeutral500,
                      ),
                      Expanded(
                        child: Container(
                          height: LimsTokens.space0x5,
                          color: i == all.length - 1
                              ? LimsTokens.colorNeutral0
                              : line(i < current),
                        ),
                      ),
                    ],
                  ),
                  Text(
                    all[i],
                    textAlign: TextAlign.center,
                    style: t.labelSmall?.copyWith(
                      fontWeight: i == current
                          ? FontWeight.w700
                          : FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Sharing extends StatelessWidget {
  const _Sharing({required this.state, this.onOpenLocationSettings});

  final TravelState state;
  final VoidCallback? onOpenLocationSettings;

  @override
  Widget build(BuildContext context) {
    switch (state.sharing) {
      case LocationSharing.live:
        return Align(
          alignment: Alignment.centerLeft,
          child: LimsStatusChip(
            kind: 'generic',
            status: 'live',
            tone: 'success',
            label:
                'Live${state.lastShared == null ? '' : ' · ${state.lastShared}'}',
          ),
        );
      case LocationSharing.delayed:
        return const PhleboNotice(
          tone: 'warning',
          title: 'Location is a little late',
          text: 'The patient still sees your last position. Keep the app open.',
        );
      case LocationSharing.noSignal:
        return const PhleboNotice(
          tone: 'warning',
          icon: Icons.cloud_off,
          title: 'No signal',
          text: 'Your position is saved on the phone and goes out when the signal is back.',
        );
      case LocationSharing.permissionOff:
        return PhleboNotice(
          tone: 'danger',
          title: 'Location is off',
          text: 'The patient cannot see where you are. Turn location on to share it.',
          action: onOpenLocationSettings,
          actionLabel: 'Open phone settings',
        );
      case LocationSharing.paused:
        return const PhleboNotice(tone: 'neutral', text: 'Sharing is paused.');
    }
  }
}
