// My bookings: newest first, each with ID, status, when, who and mode, tests, total and payment method.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnBookingsScreen extends ConsumerWidget {
  const MhnBookingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(mhnProvider.select((s) => s.bookings)).reversed.toList();
    return MhnPage(
      title: 'My bookings',
      child: list.isEmpty
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const MhnIconTile(Icons.event_available_outlined, size: 64),
                  const SizedBox(height: 16),
                  Text('No bookings yet', style: Mhn.t(17, w: FontWeight.w700)),
                  const SizedBox(height: 6),
                  Text('Your upcoming and past collections will appear here.', textAlign: TextAlign.center, style: Mhn.body),
                ]),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                for (final b in list)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: MhnCard(
                      padding: const EdgeInsets.all(14),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          Expanded(child: Text(b.id, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.muted))),
                          const MhnTag('Upcoming'),
                        ]),
                        const SizedBox(height: 6),
                        Text(b.when, style: Mhn.t(17, w: FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text('${b.who} · ${b.mode == 'home' ? 'Home collection' : 'Centre visit'}', style: Mhn.t(14, c: Mhn.muted)),
                        const SizedBox(height: 2),
                        Text(b.items.join(', '), style: Mhn.t(13, c: Mhn.muted)),
                        const SizedBox(height: 8),
                        Row(children: [Text(rs(b.total), style: Mhn.t(15, w: FontWeight.w800)), const Spacer(), Text(b.payLabel, style: Mhn.t(13, c: Mhn.muted))]),
                      ]),
                    ),
                  ),
              ],
            ),
    );
  }
}
