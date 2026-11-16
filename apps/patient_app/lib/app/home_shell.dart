// A5 Home (C16 04-UI-UX §1.1 and A5; 03-APP-FLOW A5: E13, E20, E45 badge). T0C-M4-PATIENT-1 / LD-258: the M4 shell that replaces the
// router's text placeholder. App bar: bell with the unread count (NotificationBell, E45 unread_only=true, "9+") and the profile switcher
// (E13; selection in memory only). LimsBottomNav: Orders (default) · Reports · More, text labels, lime pill on the current tab.
// The Bookings tab needs the E1 `features.bookings` flag, which the app has no provider for yet: hidden (impl note open point).
// Home shows ONLY that (no popular tests, categories, packages, visit-the-centre or FAQ: board elements without a spec screen, LD-258 gaps).
// PHI: the shell is wrapped in LimsSecureScreen (REQ-SEC-109). Tab bodies are the existing screens; only the current one is built.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../features/enquiries/enquiries_screen.dart';
import '../features/enquiries/enquiry_thread_screen.dart';
import '../features/enquiries/new_enquiry_screen.dart';
import '../features/membership/membership_screen.dart';
import '../features/notifications/notification_bell.dart';
import '../features/notifications/notifications_screen.dart';
import '../features/orders/orders_list_screen.dart';
import '../features/profiles/profile_copy.dart';
import '../features/profiles/profiles_providers.dart';
import '../features/profiles/profiles_screen.dart';
import '../features/reports/reports_list_screen.dart';
import '../features/settings/settings_screen.dart';
import 'providers.dart';

/// E13 for the switcher: display name + relationship label. A failed list shows "All profiles" only (the bar never breaks).
final homeProfilesProvider = FutureProvider.autoDispose<List<LimsProfile>>((ref) async {
  try {
    final list = parseProfileList(await ref.watch(profilesApiProvider).listMyProfiles());
    return [for (final p in list.profiles) (id: p.id, label: p.name, sublabel: relationshipLabels[p.relationship] ?? '')];
  } catch (_) {
    return const [];
  }
});

const _tabs = <LimsNavItem>[
  (icon: Icons.receipt_long_outlined, label: 'Orders', badge: null),
  (icon: Icons.description_outlined, label: 'Reports', badge: null),
  (icon: Icons.menu, label: 'More', badge: null),
];

class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key});

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  int _tab = 0;
  String? _profileId; // in memory only (04-UI-UX §1.1)

  void _push(Widget screen) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

  Widget _more() => ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
        LimsCard(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            LimsListTile(title: 'Profiles', leading: const Icon(Icons.groups_outlined), onTap: () => _push(const ProfilesScreen())),
            LimsListTile(title: 'Membership card', leading: const Icon(Icons.card_membership_outlined), onTap: () => _push(const MembershipScreen())),
            LimsListTile(
              title: 'Messages',
              leading: const Icon(Icons.chat_bubble_outline),
              onTap: () => _push(Builder(
                builder: (c) => EnquiriesScreen(
                  onOpen: (id) => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => EnquiryThreadScreen(enquiryId: id))),
                  onNew: () => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => const NewEnquiryScreen())),
                ),
              )),
            ),
            LimsListTile(title: 'Settings', leading: const Icon(Icons.settings_outlined), onTap: () => _push(const SettingsScreen())),
          ]),
        ),
      ]);

  @override
  Widget build(BuildContext context) {
    final profiles = ref.watch(homeProfilesProvider).value ?? const <LimsProfile>[];
    return LimsSecureScreen(
      child: Scaffold(
        appBar: AppBar(
          title: Text(ref.watch(flavourProvider).displayName),
          actions: [NotificationBell(onPressed: () => _push(const NotificationsScreen()))],
        ),
        body: Column(children: [
          if (_tab != _tabs.length - 1)
            Material(
              color: LimsTokens.colorNeutral0,
              child: LimsProfileSwitcher(profiles: profiles, selectedId: _profileId, onChanged: (id) => setState(() => _profileId = id)),
            ),
          Expanded(
            child: switch (_tab) {
              0 => const OrdersListScreen(),
              1 => const ReportsListScreen(),
              _ => _more(),
            },
          ),
        ]),
        bottomNavigationBar: LimsBottomNav(items: _tabs, index: _tab, onTap: (i) => setState(() => _tab = i)),
      ),
    );
  }
}
