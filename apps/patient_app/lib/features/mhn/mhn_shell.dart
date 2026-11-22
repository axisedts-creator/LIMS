// My Health Now shell: five approved tabs (Home, All Tests, Bookings, Reports, Profile)
// with the bottom bar and the floating cart bar per ADR-UI-NAV-001.
// Pushed screens (category, packages, cart, booking...) use MhnPage. Tab choice is in memory only.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'bookings_screen.dart';
import 'cart_screen.dart';
import 'home_tab.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'profile_tab.dart';
import 'reports_screen.dart';
import 'tests_tab.dart';

class MhnTabController extends Notifier<int> {
  @override
  int build() => 0;
  void go(int tab) => state = tab;
}

final mhnTabProvider = NotifierProvider<MhnTabController, int>(
  MhnTabController.new,
);

const mhnTabHome = 0;
const mhnTabTests = 1;
const mhnTabBookings = 2;
const mhnTabReports = 3;
const mhnTabProfile = 4;
const mhnTabContact = -1; // Retained for backwards compatibility; contact lives in Profile/Header

Future<T?> mhnPush<T>(BuildContext context, Widget screen) =>
    Navigator.of(context).push<T>(MaterialPageRoute<T>(builder: (_) => screen));

/// "N items   View cart ›" bar shown above the bottom bar (and on category / packages screens) while the cart is not empty.
class MhnCartBar extends ConsumerWidget {
  const MhnCartBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = ref.watch(mhnProvider.select((s) => s.cart.length));
    if (n == 0) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Material(
        color: Mhn.green,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => mhnPush<void>(context, const MhnCartScreen()),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
            child: Row(
              children: [
                Text(
                  '$n ${n == 1 ? 'item' : 'items'}',
                  style: Mhn.t(14, w: FontWeight.w700, c: Mhn.white),
                ),
                const Spacer(),
                Text(
                  'View cart',
                  style: Mhn.t(14, w: FontWeight.w800, c: Mhn.lime),
                ),
                const SizedBox(width: 4),
                const Icon(Icons.chevron_right, size: 20, color: Mhn.lime),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class MhnShell extends ConsumerWidget {
  const MhnShell({super.key});

  static const _items = <(IconData, String)>[
    (Icons.home_outlined, 'Home'),
    (Icons.science_outlined, 'All Tests'),
    (Icons.event_available_outlined, 'Bookings'),
    (Icons.description_outlined, 'Reports'),
    (Icons.person_outline, 'Profile'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tab = ref.watch(mhnTabProvider);
    final body = switch (tab) {
      mhnTabHome => const MhnHomeTab(),
      mhnTabTests => const MhnTestsTab(),
      mhnTabBookings => const MhnBookingsScreen(isTab: true),
      mhnTabReports => const MhnReportsScreen(isTab: true),
      _ => const MhnProfileTab(),
    };
    return Scaffold(
      backgroundColor: Mhn.page,
      body: SafeArea(bottom: false, child: body),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (tab == mhnTabHome || tab == mhnTabTests) const MhnCartBar(),
          Container(
            decoration: const BoxDecoration(
              color: Mhn.white,
              border: Border(top: BorderSide(color: Mhn.line)),
            ),
            child: SafeArea(
              top: false,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 64),
                child: Row(
                  children: [
                    for (var i = 0; i < _items.length; i++)
                      Expanded(
                        key: ValueKey<String>('mhn-nav-${_items[i].$2}'),
                        child: Semantics(
                          button: true,
                          selected: tab == i,
                          label: _items[i].$2,
                          child: InkWell(
                            onTap: () =>
                                ref.read(mhnTabProvider.notifier).go(i),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Container(
                                  width: tab == i ? 28 : 0,
                                  height: 3,
                                  margin: const EdgeInsets.only(bottom: 6),
                                  decoration: BoxDecoration(
                                    color: Mhn.green,
                                    borderRadius: BorderRadius.circular(2),
                                  ),
                                ),
                                Icon(
                                  _items[i].$1,
                                  size: 24,
                                  color: tab == i ? Mhn.green : Mhn.muted,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _items[i].$2,
                                  style: Mhn.t(
                                    12,
                                    w: tab == i
                                        ? FontWeight.w700
                                        : FontWeight.w600,
                                    c: tab == i ? Mhn.green : Mhn.muted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
