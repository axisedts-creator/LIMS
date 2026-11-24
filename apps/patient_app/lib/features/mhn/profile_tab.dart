// Profile tab: header, ACCOUNT (my profile + completeness, other members, BS/AD calendar), SERVICES (reports, bookings, membership),
// INFORMATION (about, privacy, terms, rate us, report a problem). Privacy / Terms are marked Draft until Metro Labs' legal review.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bookings/addresses_screen.dart';
import '../profiles/profiles_screen.dart';
import '../auth/sign_in_flow.dart';
import '../../core/session/session_controller.dart';
import '../../app/providers.dart';
import 'about_screen.dart';
import 'contact_tab.dart';
import 'live_tracking_screen.dart';
import 'members_screen.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'my_profile_screen.dart';
import 'placeholders_screens.dart';
import 'problem_screen.dart';

class MhnProfileTab extends ConsumerWidget {
  const MhnProfileTab({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final p = st.profile;
    final session = ref.watch(sessionControllerProvider);
    final isGuest = session.status.value != SessionStatus.signedIn;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 100),
      children: [
        Row(children: [
          MhnAvatar(name: p.name, radius: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(p.name, style: Mhn.t(20, w: FontWeight.w800)),
              Text('+977 ${p.phone}', style: Mhn.t(13, c: Mhn.muted)),
            ]),
          ),
          if (isGuest)
            OutlinedButton(
              style: OutlinedButton.styleFrom(
                foregroundColor: Mhn.green,
                side: const BorderSide(color: Mhn.green),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              ),
              onPressed: () => mhnPush<void>(context, const SignInFlow()),
              child: const Text('Sign in', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            ),
        ]),
        const _Label('ACCOUNT'),
        MhnCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _Row(
              icon: Icons.person_outline,
              title: 'My profile',
              onTap: () => mhnPush<void>(context, const MhnMyProfileScreen()),
              middle: Padding(
                padding: const EdgeInsets.only(top: 6, right: 4),
                child: Row(children: [
                  Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: p.completeness / 100, minHeight: 5, backgroundColor: Mhn.tint, color: Mhn.green))),
                  const SizedBox(width: 8),
                  Text('${p.completeness}%', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.muted)),
                ]),
              ),
            ),
            _Row(icon: Icons.groups_2_outlined, title: 'Other members', trailing: st.members.isEmpty ? 'None' : '${st.members.length}', onTap: () => mhnPush<void>(context, const MhnMembersScreen())),
            _Row(icon: Icons.badge_outlined, title: 'Lab profiles', onTap: () => mhnPush<void>(context, const ProfilesScreen())),
            _Row(icon: Icons.location_on_outlined, title: 'Saved addresses', onTap: () => mhnPush<void>(context, const AddressesScreen())),
            _Row(
              icon: Icons.dashboard_customize_outlined,
              title: 'Healthians v1.1 Mode',
              badge: st.v1_1Mode ? 'Active' : 'Classic',
              onTap: () {
                ctl.toggleV11Mode();
                mhnToast(context, st.v1_1Mode ? 'Switched to Classic layout' : 'Switched to Healthians v1.1 layout');
              },
            ),
            _Row(
              icon: Icons.calendar_today_outlined,
              title: 'Calendar',
              custom: Container(
                padding: const EdgeInsets.all(3),
                decoration: BoxDecoration(color: Mhn.tint, borderRadius: BorderRadius.circular(10)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  for (final k in const ['BS', 'AD'])
                    GestureDetector(
                      onTap: () {
                        if (st.calendar != k) {
                          ctl.toggleCalendar();
                          mhnToast(context, 'Dates will show in ${k == 'BS' ? 'Bikram Sambat' : 'English (AD)'}');
                        }
                      },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                        decoration: BoxDecoration(color: st.calendar == k ? Mhn.green : Colors.transparent, borderRadius: BorderRadius.circular(8)),
                        child: Text(k, style: Mhn.t(12, w: FontWeight.w800, c: st.calendar == k ? Mhn.white : Mhn.muted)),
                      ),
                    ),
                ]),
              ),
            ),
          ]),
        ),
        const _Label('SERVICES'),
        MhnCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _Row(icon: Icons.description_outlined, title: 'Reports', onTap: () => ref.read(mhnTabProvider.notifier).go(mhnTabReports)),
            _Row(icon: Icons.event_available_outlined, title: 'Bookings', trailing: st.bookings.isEmpty ? '' : '${st.bookings.length}', onTap: () => ref.read(mhnTabProvider.notifier).go(mhnTabBookings)),
            if (st.v1_1Mode) ...[
              _Row(icon: Icons.route_outlined, title: 'Live phlebotomist tracking', onTap: () => mhnPush<void>(context, const MhnLiveTrackingScreen())),
              _Row(icon: Icons.account_balance_wallet_outlined, title: 'My wallet', onTap: () => mhnPush<void>(context, const MhnWalletScreen())),
              _Row(icon: Icons.card_giftcard_outlined, title: 'Refer & earn', onTap: () => mhnPush<void>(context, const MhnReferEarnScreen())),
              _Row(icon: Icons.casino_outlined, title: 'Lucky draw', onTap: () => mhnPush<void>(context, const MhnLuckyDrawScreen())),
              _Row(icon: Icons.business_outlined, title: 'Corporate verification', onTap: () => mhnPush<void>(context, const MhnCorporateScreen())),
              _Row(icon: Icons.design_services_outlined, title: 'Make your own package', onTap: () => mhnPush<void>(context, const MhnMakePackageScreen())),
            ],
          ]),
        ),
        const _Label('INFORMATION'),
        MhnCard(
          padding: EdgeInsets.zero,
          child: Column(children: [
            _Row(icon: Icons.phone_outlined, title: 'Contact us', onTap: () => mhnPush<void>(context, const MhnPage(title: 'Contact us', child: MhnContactTab()))),
            _Row(icon: Icons.info_outline, title: 'About us', onTap: () => mhnPush<void>(context, const MhnAboutScreen())),
            _Row(icon: Icons.lock_outline, title: 'Privacy policy', badge: 'Draft', onTap: () => mhnToast(context, 'Draft text awaiting Metro Labs legal review')),
            _Row(icon: Icons.description_outlined, title: 'Terms & conditions', badge: 'Draft', onTap: () => mhnToast(context, 'Draft text awaiting Metro Labs legal review')),
            _Row(icon: Icons.star_outline, title: 'Rate us', onTap: () => showMhnRateSheet(context)),
            _Row(icon: Icons.flag_outlined, title: 'Report a problem', onTap: () => mhnPush<void>(context, const MhnProblemScreen())),
          ]),
        ),
        if (!isGuest) ...[
          const SizedBox(height: 16),
          MhnCard(
            padding: EdgeInsets.zero,
            child: _Row(
              icon: Icons.logout,
              title: 'Sign out',
              onTap: () async {
                await ref.read(sessionControllerProvider).logout();
              },
            ),
          ),
        ],
        const SizedBox(height: 24),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.fromLTRB(2, 22, 0, 8), child: Text(text, style: Mhn.t(12, w: FontWeight.w800, c: Mhn.mutedSoft).copyWith(letterSpacing: 1)));
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.title, this.onTap, this.trailing, this.badge, this.middle, this.custom});
  final IconData icon;
  final String title;
  final VoidCallback? onTap;
  final String? trailing;
  final String? badge;
  final Widget? middle;
  final Widget? custom;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(children: [
            MhnIconTile(icon, size: 38),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: Mhn.t(15, w: FontWeight.w700)),
                if (middle != null) middle!,
              ]),
            ),
            if (trailing != null && trailing!.isNotEmpty) Padding(padding: const EdgeInsets.only(right: 4), child: Text(trailing!, style: Mhn.t(13, c: Mhn.muted))),
            if (badge != null) Padding(padding: const EdgeInsets.only(right: 4), child: MhnTag(badge!, bg: Mhn.warnBg, fg: Mhn.warnFg)),
            if (custom != null) custom!,
            if (custom == null && onTap != null) const Icon(Icons.chevron_right, size: 22, color: Mhn.muted),
          ]),
        ),
      );
}

/// "Enjoying My Health Now?" bottom sheet with five stars. Opens the store rating page in the real app (toast in this UI).
Future<void> showMhnRateSheet(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      backgroundColor: Mhn.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (sheetContext) => const _RateSheet(),
    );

class _RateSheet extends StatefulWidget {
  const _RateSheet();

  @override
  State<_RateSheet> createState() => _RateSheetState();
}

class _RateSheetState extends State<_RateSheet> {
  int _stars = 0;

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(width: 40, height: 4, decoration: BoxDecoration(color: Mhn.lineStrong, borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 18),
            Text('Enjoying My Health Now?', style: Mhn.t(18, w: FontWeight.w800)),
            const SizedBox(height: 6),
            Text('Your rating goes to the Play Store or App Store.', textAlign: TextAlign.center, style: Mhn.body),
            const SizedBox(height: 14),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var n = 1; n <= 5; n++)
                IconButton(
                  tooltip: '$n star${n > 1 ? 's' : ''}',
                  onPressed: () => setState(() => _stars = n),
                  icon: Icon(n <= _stars ? Icons.star : Icons.star_border, size: 36, color: n <= _stars ? Mhn.star : const Color(0xFF8FA89B)),
                ),
            ]),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: MhnButton(label: 'Not now', secondary: true, onPressed: () => Navigator.of(context).pop())),
              const SizedBox(width: 10),
              Expanded(
                child: MhnButton(
                  label: 'Continue',
                  onPressed: () {
                    final stars = _stars;
                    final messenger = ScaffoldMessenger.of(context);
                    Navigator.of(context).pop();
                    mhnToastOn(messenger, stars > 0 ? 'Opening the store to post your $stars-star rating' : 'Opening the store rating page');
                  },
                ),
              ),
            ]),
          ]),
        ),
      );
}
