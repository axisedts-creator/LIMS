// Booking confirmed: check mark, booking ID, "what happens next", View my bookings / Back to home.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'bookings_screen.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnDoneScreen extends ConsumerWidget {
  const MhnDoneScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(mhnProvider);
    final home = st.doneMode != 'lab';
    final steps = <String>[
      home ? 'We send you an SMS the day before with your collection time.' : 'We send you an SMS the day before with your visit time.',
      home ? 'A phlebotomist arrives at your address in the slot you chose.' : 'Show your booking ID at the Baneshwor reception.',
      'Your report appears in Profile › Reports, and we notify you when it is ready.',
    ];
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).popUntil((r) => r.isFirst);
      },
      child: Scaffold(
        backgroundColor: Mhn.page,
        appBar: const MhnTopBar('Confirmed'),
        body: ListView(
          padding: const EdgeInsets.fromLTRB(16, 28, 16, 24),
          children: [
            Center(
              child: Container(
                width: 84,
                height: 84,
                decoration: const BoxDecoration(shape: BoxShape.circle, color: Mhn.green),
                child: const Icon(Icons.check, size: 44, color: Mhn.lime),
              ),
            ),
            const SizedBox(height: 16),
            Center(child: Text('Booking confirmed', style: Mhn.t(24, w: FontWeight.w800))),
            const SizedBox(height: 4),
            Center(child: Text('Booking ID ${st.lastId}', style: Mhn.t(14, c: Mhn.muted))),
            const SizedBox(height: 20),
            MhnCard(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('What happens next', style: Mhn.t(15, w: FontWeight.w800)),
                const SizedBox(height: 12),
                for (var i = 0; i < steps.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Container(width: 26, height: 26, alignment: Alignment.center, decoration: const BoxDecoration(shape: BoxShape.circle, color: Mhn.tint), child: Text('${i + 1}', style: Mhn.t(12, w: FontWeight.w800, c: Mhn.green))),
                      const SizedBox(width: 10),
                      Expanded(child: Text(steps[i], style: Mhn.t(14, h: 1.35))),
                    ]),
                  ),
              ]),
            ),
            const SizedBox(height: 16),
            MhnButton(label: 'View my bookings', onPressed: () => mhnPush<void>(context, const MhnBookingsScreen())),
            const SizedBox(height: 10),
            MhnButton(label: 'Back to home', secondary: true, onPressed: () {
              ref.read(mhnTabProvider.notifier).go(mhnTabHome);
              Navigator.of(context).popUntil((r) => r.isFirst);
            }),
          ],
        ),
      ),
    );
  }
}
