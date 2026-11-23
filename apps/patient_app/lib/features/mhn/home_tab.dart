// Home tab of the prototype: greeting + member pill + cart, search, hero carousel, quick actions, popular tests, categories,
// age checkups, packages carousel and the certification strip.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bookings/bookings_api.dart';
import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import 'cart_screen.dart';
import 'category_screen.dart';
import 'mhn_data.dart';
import 'mhn_package_card.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'packages_screen.dart';

class MhnHomeTab extends ConsumerStatefulWidget {
  const MhnHomeTab({super.key});

  @override
  ConsumerState<MhnHomeTab> createState() => _MhnHomeTabState();
}

class _MhnHomeTabState extends ConsumerState<MhnHomeTab> {
  final _hero = PageController();
  Timer? _heroTimer;
  Timer? _phTimer;
  int _slide = 0;
  int _ph = 0;
  String? _openPkg;
  bool _held = false;

  @override
  void initState() {
    super.initState();
    _phTimer = Timer.periodic(const Duration(milliseconds: 2600), (_) {
      if (mounted) setState(() => _ph = (_ph + 1) % kPlaceholders.length);
    });
    _heroTimer = Timer.periodic(const Duration(milliseconds: 4800), (_) {
      if (!mounted || _held || !_hero.hasClients) return;
      _hero.animateToPage(
        (_slide + 1) % kHero.length,
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  void dispose() {
    _phTimer?.cancel();
    _heroTimer?.cancel();
    _hero.dispose();
    super.dispose();
  }

  void _heroGo(String go) {
    switch (go) {
      case 'packages':
        mhnPush<void>(context, const MhnPackagesScreen());
      default:
        ref.read(mhnTabProvider.notifier).go(mhnTabTests);
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final first = st.profile.name.split(' ').first;
    final popular = [
      for (final id in kPopularIds) kTests.firstWhere((t) => t.id == id),
    ];
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        // header
        Row(
          children: [
            Semantics(
              button: true,
              label: 'Open profile',
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: () =>
                    ref.read(mhnTabProvider.notifier).go(mhnTabProfile),
                child: CircleAvatar(
                  radius: 22,
                  backgroundColor: Mhn.green,
                  child: Text(
                    st.profile.name[0],
                    style: Mhn.t(18, w: FontWeight.w700, c: Mhn.white),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Hi, $first',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Mhn.t(16, w: FontWeight.w700),
                  ),
                  InkWell(
                    onTap: () => showCitySelectionSheet(context, ref),
                    borderRadius: BorderRadius.circular(4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(
                            st.selectedLocationLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Mhn.t(13, c: Mhn.muted),
                          ),
                        ),
                        const SizedBox(width: 4),
                        const Icon(Icons.keyboard_arrow_down, size: 16, color: Mhn.muted),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Semantics(
              button: true,
              label: 'Cart',
              child: Material(
                color: Mhn.white,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                  side: const BorderSide(color: Mhn.line),
                ),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => mhnPush<void>(context, const MhnCartScreen()),
                  child: SizedBox(
                    width: 46,
                    height: 46,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        const Icon(
                          Icons.shopping_cart_outlined,
                          size: 22,
                          color: Mhn.ink,
                        ),
                        if (st.cart.isNotEmpty)
                          Positioned(
                            top: 4,
                            right: 4,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 5,
                                vertical: 1,
                              ),
                              decoration: BoxDecoration(
                                color: Mhn.green,
                                borderRadius: BorderRadius.circular(9),
                              ),
                              child: Text(
                                '${st.cart.length}',
                                style: Mhn.t(
                                  11,
                                  w: FontWeight.w700,
                                  c: Mhn.white,
                                ),
                              ),
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
        const SizedBox(height: 18),
        // search (opens the All Tests tab)
        Semantics(
          button: true,
          label: 'Search tests',
          child: InkWell(
            borderRadius: BorderRadius.circular(Mhn.rField),
            onTap: () => ref.read(mhnTabProvider.notifier).go(mhnTabTests),
            child: Container(
              height: 54,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              decoration: BoxDecoration(
                color: Mhn.white,
                borderRadius: BorderRadius.circular(Mhn.rField),
                border: Border.all(color: Mhn.line),
                boxShadow: const [
                  BoxShadow(
                    color: Mhn.shadow,
                    blurRadius: 18,
                    offset: Offset(0, 6),
                  ),
                ],
              ),
              child: Row(
                children: [
                  const Icon(Icons.search, size: 22, color: Mhn.green),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        style: Mhn.t(15, c: Mhn.muted),
                        children: [
                          const TextSpan(text: 'Search for ‘'),
                          TextSpan(
                            text: kPlaceholders[_ph],
                            style: Mhn.t(15, w: FontWeight.w700, c: Mhn.green),
                          ),
                          const TextSpan(text: '’'),
                        ],
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 16),
        // hero carousel
        SizedBox(
          height:
              236 +
              (MediaQuery.textScalerOf(context).scale(1) - 1).clamp(0.0, 0.15) *
                  300,
          child: Stack(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: PageView.builder(
                  controller: _hero,
                  itemCount: kHero.length,
                  onPageChanged: (i) => setState(() => _slide = i),
                  itemBuilder: (_, i) => MediaQuery.withClampedTextScaling(
                    maxScaleFactor: 1.15,
                    child: _HeroSlide(
                      slide: kHero[i],
                      onTap: () => _heroGo(kHero[i].go),
                    ),
                  ),
                ),
              ),
              Positioned(
                right: 18,
                bottom: 22,
                child: Row(
                  children: [
                    for (var i = 0; i < kHero.length; i++)
                      Semantics(
                        button: true,
                        label: 'Show slide ${i + 1}',
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () {
                            _held = true;
                            _hero.animateToPage(
                              i,
                              duration: const Duration(milliseconds: 250),
                              curve: Curves.easeOut,
                            );
                          },
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 4,
                              vertical: 8,
                            ),
                            child: AnimatedContainer(
                              duration: const Duration(milliseconds: 200),
                              width: i == _slide ? 22 : 6,
                              height: 6,
                              decoration: BoxDecoration(
                                color: i == _slide
                                    ? Mhn.lime
                                    : const Color(0x59FFFFFF),
                                borderRadius: BorderRadius.circular(3),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        // quick actions
        Row(
          children: [
            Expanded(
              child: _QuickAction(
                icon: Icons.local_shipping_outlined,
                label: 'Home Sample Collection',
                onTap: () => ref.read(mhnTabProvider.notifier).go(mhnTabTests),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _QuickAction(
                icon: Icons.upload_outlined,
                label: 'Upload Prescription',
                onTap: () => mhnToast(
                  context,
                  'Prescription upload opens the camera in the app',
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 22),
        _SectionTitle(
          'Popular tests',
          action: 'See all',
          onAction: () => ref.read(mhnTabProvider.notifier).go(mhnTabTests),
        ),
        const SizedBox(height: 10),
        MhnCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              for (var i = 0; i < popular.length; i++)
                _PopularRow(test: popular[i], divider: i > 0),
            ],
          ),
        ),
        const SizedBox(height: 22),
        const _SectionTitle('Tests by category'),
        const SizedBox(height: 10),
        SizedBox(
          height: 46,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: kCategories.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (_, i) => MhnChip(
              label: kCategories[i].name,
              selected: false,
              radius: 14,
              onTap: () => mhnPush<void>(
                context,
                MhnCategoryScreen(category: kCategories[i]),
              ),
            ),
          ),
        ),
        const SizedBox(height: 22),
        const _SectionTitle('Routine Health Checkup for Men'),
        const SizedBox(height: 10),
        const _AgeRow(),
        const SizedBox(height: 22),
        const _SectionTitle('Routine Health Checkup for Women'),
        const SizedBox(height: 10),
        const _AgeRow(),
        const SizedBox(height: 22),
        _SectionTitle(
          'Health Checkup Packages',
          action: 'View all',
          onAction: () => mhnPush<void>(context, const MhnPackagesScreen()),
        ),
        const SizedBox(height: 10),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final p in kPackages)
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: MhnPackageCard(
                    pkg: p,
                    width: 200,
                    open: _openPkg == p.id,
                    onToggleOpen: () => setState(
                      () => _openPkg = _openPkg == p.id ? null : p.id,
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: Mhn.tint,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              const Icon(
                Icons.verified_user_outlined,
                size: 22,
                color: Mhn.green,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'ISO 9001:2015 certified · NPHL approved',
                  style: Mhn.t(13, w: FontWeight.w700, c: Mhn.tintFg),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _HeroSlide extends StatelessWidget {
  const _HeroSlide({required this.slide, required this.onTap});
  final MhnHeroSlide slide;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Container(
    color: const Color(0xFF234D40),
    child: Stack(
      children: [
        Positioned(
          right: -60,
          top: -46,
          child: Container(
            width: 210,
            height: 210,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: const Color(0x1AFFFFFF), width: 28),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                slide.tag.toUpperCase(),
                style: Mhn.t(
                  12,
                  w: FontWeight.w700,
                  c: Mhn.lime,
                ).copyWith(letterSpacing: 1),
              ),
              const SizedBox(height: 8),
              Text(
                slide.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Mhn.t(22, w: FontWeight.w800, c: Mhn.white, h: 1.2),
              ),
              const SizedBox(height: 8),
              Text(
                slide.sub,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Mhn.t(14, c: const Color(0xE6FFFFFF), h: 1.3),
              ),
              const Spacer(),
              Align(
                alignment: Alignment.centerLeft,
                child: Material(
                  color: Mhn.lime,
                  borderRadius: BorderRadius.circular(14),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: onTap,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 20,
                        vertical: 13,
                      ),
                      child: Text(
                        slide.cta,
                        style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: Mhn.white,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: const BorderSide(color: Mhn.line),
    ),
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            MhnIconTile(icon),
            const SizedBox(width: 10),
            Expanded(
              child: Text(label, style: Mhn.t(13, w: FontWeight.w700, h: 1.25)),
            ),
          ],
        ),
      ),
    ),
  );
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, {this.action, this.onAction});
  final String text;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(child: Text(text, style: Mhn.h2)),
      if (action != null)
        TextButton(
          onPressed: onAction,
          child: Text(
            action!,
            style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green),
          ),
        ),
    ],
  );
}

class _PopularRow extends ConsumerWidget {
  const _PopularRow({required this.test, required this.divider});
  final MhnTest test;
  final bool divider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inCart = ref.watch(
      mhnProvider.select((s) => s.cart.contains(test.id)),
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        border: divider
            ? const Border(top: BorderSide(color: Mhn.rowLine))
            : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(test.name, style: Mhn.t(15, w: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(
                  '${test.fasting} · Report ${test.report}',
                  style: Mhn.t(12, c: Mhn.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(rs(test.price), style: Mhn.t(14, w: FontWeight.w800)),
          const SizedBox(width: 10),
          Semantics(
            button: true,
            label: inCart ? 'Remove ${test.name}' : 'Add ${test.name}',
            child: Material(
              color: inCart ? Mhn.green : Mhn.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: const BorderSide(color: Mhn.green, width: 1.2),
              ),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () {
                  registerCartItem(MhnCartItem(
                    test.id,
                    test.name,
                    test.price,
                    '${test.fasting} · Report ${test.report}',
                    test.centre,
                  ));
                  ref.read(mhnProvider.notifier).toggleCart(test.id);
                },
                child: SizedBox(
                  width: 44,
                  height: 44,
                  child: Icon(
                    inCart ? Icons.check : Icons.add,
                    size: 22,
                    color: inCart ? Mhn.white : Mhn.green,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AgeRow extends ConsumerWidget {
  const _AgeRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) => Row(
    children: [
      for (var i = 0; i < kAgeBands.length; i++) ...[
        if (i > 0) const SizedBox(width: 8),
        Expanded(
          child: Material(
            color: Mhn.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: const BorderSide(color: Mhn.line),
            ),
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Column(
                  children: [
                    Text(kAgeBands[i].$1, style: Mhn.t(15, w: FontWeight.w800)),
                    Text(kAgeBands[i].$2, style: Mhn.t(12, c: Mhn.muted)),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    ],
  );
}

/// H02 City / Service Location selection bottom sheet (E31 listMyBookingCentres).
Future<void> showCitySelectionSheet(BuildContext context, WidgetRef ref) async {
  PatientBookingsApi? api;
  try {
    api = ref.read(patientBookingsApiProvider);
  } catch (_) {
    api = null;
  }

  List<Map<String, Object?>> centres = [];
  if (api != null) {
    try {
      final res = asMap(await api.listBookingCentres(bookingKind: 'home_collection'));
      centres = mapList(res?['data']);
    } catch (_) {
      centres = [];
    }
  }

  if (centres.isEmpty) {
    centres = const [
      {
        'centre_id': '01950c16-0000-7000-8000-000000000031',
        'display_name': 'MetroLabs Baneshwor',
        'address_text': 'Baneshwor, Kathmandu',
      },
      {
        'centre_id': '01950c16-0000-7000-8000-000000000032',
        'display_name': 'MetroLabs Lalitpur',
        'address_text': 'Patan, Lalitpur',
      },
    ];
  }

  if (!context.mounted) return;

  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: Mhn.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (ctx) {
      final current = ref.watch(mhnProvider).selectedLocationLabel;
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('Select service location', style: Mhn.h2),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.close, color: Mhn.muted),
                    onPressed: () => Navigator.of(ctx).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                'Choose your city or branch to check test availability and booking slots.',
                style: Mhn.t(13, c: Mhn.muted),
              ),
              const SizedBox(height: 16),
              for (final c in centres) ...[
                Builder(
                  builder: (_) {
                    final label = (c['address_text'] as String?)?.isNotEmpty == true
                        ? c['address_text'] as String
                        : (c['display_name'] as String? ?? 'Kathmandu');
                    final id = c['centre_id'] as String?;
                    final isSelected = current == label;
                    return ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      leading: Icon(
                        isSelected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                        color: isSelected ? Mhn.green : Mhn.muted,
                      ),
                      title: Text(label, style: Mhn.t(15, w: FontWeight.w700)),
                      subtitle: Text(
                        c['display_name'] as String? ?? '',
                        style: Mhn.t(13, c: Mhn.muted),
                      ),
                      onTap: () {
                        ref.read(mhnProvider.notifier).setSelectedLocation(
                          centreId: id,
                          locationLabel: label,
                        );
                        Navigator.of(ctx).pop();
                        mhnToast(context, 'Location set to $label');
                      },
                    );
                  },
                ),
                const Divider(height: 1, color: Mhn.line),
              ],
            ],
          ),
        ),
      );
    },
  );
}
