// My Health Now shell: five approved tabs (Home, All Tests, Bookings, Reports, Profile)
// with the bottom bar and the floating cart bar per ADR-UI-NAV-001.
// Pushed screens (category, packages, cart, booking...) use MhnPage. Tab choice is in memory only.
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'bookings_screen.dart';
import 'call_sheet.dart';
import 'cart_screen.dart';
import 'community_screens.dart';
import 'home_tab.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'mycare_screen.dart';
import 'placeholders_screens.dart';
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

/// Floating "Call to Book" widget matching Healthians wireframe & live video.
class MhnFloatingCallButton extends StatelessWidget {
  const MhnFloatingCallButton({super.key});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      elevation: 6,
      shadowColor: Colors.black26,
      borderRadius: BorderRadius.circular(24),
      child: InkWell(
        borderRadius: BorderRadius.circular(24),
        onTap: () => MhnCallSheet.show(context),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: const BoxDecoration(
                  color: Color(0xFFE8F4EC),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.phone_in_talk, size: 16, color: Mhn.green),
              ),
              const SizedBox(width: 8),
              Text(
                'Call to Book',
                style: Mhn.t(13, w: FontWeight.w700, c: Mhn.ink),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

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

class MhnShell extends ConsumerStatefulWidget {
  const MhnShell({
    super.key,
    this.showLaunchSplash = const bool.fromEnvironment('MHN_SPLASH', defaultValue: true),
  });
  final bool showLaunchSplash;

  @override
  ConsumerState<MhnShell> createState() => _MhnShellState();
}

class _MhnShellState extends ConsumerState<MhnShell> with SingleTickerProviderStateMixin {
  late bool _splashActive = widget.showLaunchSplash;
  late final AnimationController _exitCtrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 450),
  );
  late final Animation<Offset> _splashSlideOut = Tween<Offset>(
    begin: Offset.zero,
    end: const Offset(-1.0, 0.0),
  ).animate(CurvedAnimation(
    parent: _exitCtrl,
    curve: Curves.easeInOutCubic,
  ));
  late final Animation<Offset> _homeSlideIn = Tween<Offset>(
    begin: const Offset(0.30, 0.0),
    end: Offset.zero,
  ).animate(CurvedAnimation(
    parent: _exitCtrl,
    curve: Curves.easeOutCubic,
  ));

  @override
  void dispose() {
    _exitCtrl.dispose();
    super.dispose();
  }

  void _triggerSplashExit() {
    if (!_splashActive || _exitCtrl.isAnimating || _exitCtrl.isCompleted) return;
    _exitCtrl.forward().then((_) {
      if (mounted) setState(() => _splashActive = false);
    });
  }

  static const _classicItems = <(IconData, String)>[
    (Icons.home_outlined, 'Home'),
    (Icons.science_outlined, 'All Tests'),
    (Icons.event_available_outlined, 'Bookings'),
    (Icons.description_outlined, 'Reports'),
    (Icons.person_outline, 'Profile'),
  ];

  static const _v11Items = <(IconData, String)>[
    (Icons.home_outlined, 'Home'),
    (Icons.phone_outlined, 'Call'),
    (Icons.groups_outlined, 'Community'),
    (Icons.monitor_heart_outlined, 'MyCare'),
    (Icons.person_outline, 'Profile'),
  ];

  @override
  Widget build(BuildContext context) {
    final tab = ref.watch(mhnTabProvider);
    final v11 = ref.watch(mhnProvider.select((s) => s.v1_1Mode));

    final items = v11 ? _v11Items : _classicItems;

    final Widget body;
    if (v11) {
      body = switch (tab) {
        0 => const MhnHomeTab(),
        1 => const MhnHomeTab(), // Call opens sheet, keeps home active behind
        2 => const MhnCommunityScreen(),
        3 => const MhnMyCareScreen(),
        _ => const MhnProfileTab(),
      };
    } else {
      body = switch (tab) {
        mhnTabHome => const MhnHomeTab(),
        mhnTabTests => const MhnTestsTab(),
        mhnTabBookings => const MhnBookingsScreen(isTab: true),
        mhnTabReports => const MhnReportsScreen(isTab: true),
        _ => const MhnProfileTab(),
      };
    }

    final shell = Scaffold(
      backgroundColor: Mhn.page,
      extendBody: true,
      body: SafeArea(bottom: false, child: body),
      floatingActionButton: (tab == 0 && v11) ? const MhnFloatingCallButton() : null,
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(23, 0, 23, 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (tab == mhnTabHome || (!v11 && tab == mhnTabTests)) const MhnCartBar(),
              ClipRRect(
                borderRadius: BorderRadius.circular(24),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 16, sigmaY: 16),
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xF4FFFFFF),
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(color: const Color(0x22084D3B), width: 1.0),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x1E000000),
                          blurRadius: 16,
                          offset: Offset(0, 4),
                        ),
                      ],
                    ),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 54),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            children: [
                              for (var i = 0; i < items.length; i++)
                                Expanded(
                                  key: ValueKey<String>('mhn-nav-${items[i].$2}'),
                                  child: Semantics(
                                    button: true,
                                    selected: tab == i,
                                    label: items[i].$2,
                                    child: InkWell(
                                      onTap: () {
                                        if (v11 && i == 1) {
                                          MhnCallSheet.show(context);
                                        } else {
                                          ref.read(mhnTabProvider.notifier).go(i);
                                        }
                                      },
                                      child: Stack(
                                        alignment: Alignment.topCenter,
                                        children: [
                                          Padding(
                                            padding: const EdgeInsets.symmetric(vertical: 4),
                                            child: Column(
                                              mainAxisSize: MainAxisSize.min,
                                              mainAxisAlignment: MainAxisAlignment.center,
                                              children: [
                                                if (tab == i)
                                                  Transform.translate(
                                                    offset: const Offset(0, -4),
                                                    child: Container(
                                                      width: 35,
                                                      height: 35,
                                                      decoration: BoxDecoration(
                                                        shape: BoxShape.circle,
                                                        border: Border.all(color: Colors.white, width: 2.0),
                                                        gradient: const LinearGradient(
                                                          colors: [Color(0xFF00796B), Color(0xFF7CB342)],
                                                          begin: Alignment.topLeft,
                                                          end: Alignment.bottomRight,
                                                        ),
                                                        boxShadow: const [
                                                          BoxShadow(
                                                            color: Color(0x4000796B),
                                                            blurRadius: 6,
                                                            offset: Offset(0, 2),
                                                          ),
                                                        ],
                                                      ),
                                                      child: Center(
                                                        child: Icon(
                                                          items[i].$1,
                                                          size: 19,
                                                          color: Colors.white,
                                                        ),
                                                      ),
                                                    ),
                                                  )
                                                else
                                                  SizedBox(
                                                    width: 35,
                                                    height: 35,
                                                    child: Center(
                                                      child: Icon(
                                                        items[i].$1,
                                                        size: 20,
                                                        color: Mhn.muted,
                                                      ),
                                                    ),
                                                  ),
                                                const SizedBox(height: 1),
                                                Text(
                                                  items[i].$2,
                                                  style: Mhn.t(
                                                    10.5,
                                                    w: tab == i ? FontWeight.w800 : FontWeight.w600,
                                                    c: tab == i ? const Color(0xFF084D3B) : Mhn.muted,
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                          if (v11 && items[i].$2 == 'Community')
                                            Positioned(
                                              top: 2,
                                              right: 12,
                                              child: Container(
                                                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                                decoration: BoxDecoration(
                                                  color: const Color(0xFFE53935),
                                                  borderRadius: BorderRadius.circular(6),
                                                ),
                                                child: Text(
                                                  'New',
                                                  style: Mhn.t(9, w: FontWeight.w800, c: Colors.white),
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
                          Padding(
                            padding: const EdgeInsets.only(bottom: 3.5),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text('by ', style: Mhn.t(8.5, w: FontWeight.w500, c: Mhn.muted)),
                                Image.asset(
                                  'assets/brand/ml-logo-landscape.png',
                                  height: 8.5,
                                  fit: BoxFit.contain,
                                  errorBuilder: (_, __, ___) => Text(
                                    'METROLABS',
                                    style: Mhn.t(8.5, w: FontWeight.w700, c: Mhn.green),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    if (!_splashActive) {
      return shell;
    }

    return Stack(
      children: [
        SlideTransition(
          position: _homeSlideIn,
          child: shell,
        ),
        SlideTransition(
          position: _splashSlideOut,
          child: MhnSplashScreen(
            onTransitionStart: _triggerSplashExit,
            onComplete: () {
              if (mounted) setState(() => _splashActive = false);
            },
          ),
        ),
      ],
    );
  }
}
