// Home tab: matches Healthians layout wireframes & live video recording.
// Header gradient, location picker, wallet avatar pill, floating search, 3D tilt hero,
// quick actions, doctor advisor, popular tests, 3 category ribbon cards, campaign banner,
// brand ambassador card, health concerns, lifestyle concerns, allergy tests,
// age checkups, packages carousel, 3D supplements, and ISO/NPHL accreditation.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bookings/bookings_api.dart';
import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import 'call_sheet.dart';
import 'cart_screen.dart';
import 'category_screen.dart';
import 'mhn_data.dart';
import 'mhn_package_card.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'packages_screen.dart';
import 'placeholders_screens.dart';
import 'search_screen.dart';
import 'herb_screen.dart';
import 'mhn_catalog_provider.dart';
import 'mhn_location_service.dart';
import 'mhn_map_picker.dart';
import 'test_detail_screen.dart';
import 'tests_tab.dart';

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
      final int slideCount = ref.read(mhnCatalogProvider).heroSlides.length;
      if (slideCount == 0) return;
      _hero.animateToPage(
        ((_slide + 1) % slideCount).toInt(),
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
    final st = ref.read(mhnProvider);
    switch (go) {
      case 'packages':
        mhnPush<void>(context, const MhnPackagesScreen());
      default:
        if (st.v1_1Mode) {
          mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
        } else {
          ref.read(mhnTabProvider.notifier).go(mhnTabTests);
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final catalog = ref.watch(mhnCatalogProvider);
    final first = st.profile.name.split(' ').first;
    final popular = catalog.popularTests;
    final heroSlides = catalog.heroSlides;
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        // Top gradient section: Header, Search & Hero Carousel
        Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Color(0xFF084D3B), // Deep pine teal
                Color(0xFF10563E),
                Color(0xFF1B6B52),
                Color(0xFF387644),
                Color(0xFF6DA540), // Vibrant lime green
                Color(0xFFF5F7F4), // Page off-white
              ],
              stops: [0.0, 0.22, 0.44, 0.68, 0.88, 1.0],
            ),
          ),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            children: [
              // 1. Header (Greeting, Location, Wallet Avatar Pill, Notifications, Favorites, Cart)
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Hi, $first',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Mhn.t(18, w: FontWeight.w800, c: Mhn.white),
                        ),
                        const SizedBox(height: 2),
                        InkWell(
                          onTap: () => showCitySelectionSheet(context, ref),
                          borderRadius: BorderRadius.circular(4),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.location_on_outlined, size: 14, color: Color(0xFFD9EE8C)),
                              const SizedBox(width: 3),
                              Flexible(
                                child: Text(
                                  st.selectedLocationLabel,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Mhn.t(13, w: FontWeight.w600, c: const Color(0xFFD9EE8C)),
                                ),
                              ),
                              const SizedBox(width: 4),
                              const Icon(Icons.keyboard_arrow_down, size: 16, color: Color(0xFFD9EE8C)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  // User Avatar circle with wallet balance pill underneath (from wireframe Page 7)
                  Semantics(
                    button: true,
                    label: 'Open profile',
                    child: InkWell(
                      borderRadius: BorderRadius.circular(20),
                      onTap: () => ref.read(mhnTabProvider.notifier).go(mhnTabProfile),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 36,
                            height: 36,
                            padding: const EdgeInsets.all(2),
                            decoration: const BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                            ),
                            child: Center(
                              child: Text(
                                st.profile.name.isNotEmpty
                                    ? st.profile.name.split(' ').map((e) => e.isNotEmpty ? e[0] : '').take(2).join()
                                    : 'AS',
                                style: Mhn.t(13, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                              ),
                            ),
                          ),
                          Transform.translate(
                            offset: const Offset(0, -4),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                              decoration: BoxDecoration(
                                color: const Color(0xFFD9EE8C),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                'Rs. ${st.walletBalance}',
                                style: Mhn.t(8, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Semantics(
                    button: true,
                    label: 'Notifications',
                    child: Material(
                      color: const Color(0x33FFFFFF),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: const BorderSide(color: Color(0x33FFFFFF)),
                      ),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => mhnPush<void>(context, const MhnNotificationsScreen()),
                        child: SizedBox(
                          width: 40,
                          height: 40,
                          child: Stack(
                            alignment: Alignment.center,
                            children: [
                              const Icon(Icons.notifications_none_outlined, size: 21, color: Mhn.white),
                              if (st.notifications.any((n) => !n.isRead))
                                Positioned(
                                  top: 8,
                                  right: 9,
                                  child: Container(
                                    width: 7,
                                    height: 7,
                                    decoration: const BoxDecoration(
                                      color: Color(0xFFE53935),
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Semantics(
                    button: true,
                    label: 'Cart',
                    child: Material(
                      color: const Color(0x33FFFFFF),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: const BorderSide(color: Color(0x33FFFFFF)),
                      ),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () => mhnPush<void>(context, const MhnCartScreen()),
                        child: SizedBox(
                          width: 40,
                          height: 40,
                          child: Stack(
                            alignment: Alignment.center,
                            children: [
                              const Icon(
                                Icons.shopping_cart_outlined,
                                size: 20,
                                color: Mhn.white,
                              ),
                              if (st.cart.isNotEmpty)
                                Positioned(
                                  top: 4,
                                  right: 4,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 4,
                                      vertical: 1,
                                    ),
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFD9EE8C),
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Text(
                                      '${st.cart.length}',
                                      style: Mhn.t(
                                        10,
                                        w: FontWeight.w800,
                                        c: const Color(0xFF084D3B),
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
              const SizedBox(height: 16),
              // 2. Search bar (White floating card on gradient)
              Semantics(
                button: true,
                label: 'Search tests',
                child: Container(
                  height: 47,
                  padding: const EdgeInsets.symmetric(horizontal: 13),
                  decoration: BoxDecoration(
                    color: Mhn.white,
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x20000000),
                        blurRadius: 16,
                        offset: Offset(0, 5),
                      ),
                    ],
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: InkWell(
                          borderRadius: BorderRadius.circular(24),
                          onTap: () => MhnSearchScreen.open(context),
                          child: Row(
                            children: [
                              const Icon(Icons.search, size: 20, color: Color(0xFF1B6B52)),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text.rich(
                                  TextSpan(
                                    style: Mhn.t(13.5, c: Mhn.muted),
                                    children: [
                                      const TextSpan(text: 'Search for ‘'),
                                      TextSpan(
                                        text: kPlaceholders[_ph],
                                        style: Mhn.t(13.5, w: FontWeight.w700, c: const Color(0xFF1B6B52)),
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
                      IconButton(
                        padding: const EdgeInsets.all(6),
                        constraints: const BoxConstraints(),
                        icon: const Icon(Icons.mic, size: 19, color: Color(0xFF1B6B52)),
                        onPressed: () {
                          showModalBottomSheet<String>(
                            context: context,
                            backgroundColor: Colors.transparent,
                            isScrollControlled: true,
                            builder: (_) => const MhnVoiceSearchSheet(),
                          ).then((spoken) {
                            if (spoken != null && spoken.isNotEmpty && context.mounted) {
                              MhnSearchScreen.open(context, spoken);
                            }
                          });
                        },
                      ),
                      Container(width: 1, height: 18, color: Colors.black12, margin: const EdgeInsets.symmetric(horizontal: 6)),
                      InkWell(
                        onTap: () => mhnPush<void>(context, const MhnPrescriptionScreen()),
                        borderRadius: BorderRadius.circular(14),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                          child: Row(
                            children: [
                              const Icon(Icons.document_scanner_outlined, size: 17, color: Color(0xFF1B6B52)),
                              const SizedBox(width: 4),
                              Text('prescription', style: Mhn.t(10.5, w: FontWeight.w700, c: const Color(0xFF1B6B52))),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              // 3. Hero Carousel (3D Tilt Card on gradient)
              SizedBox(
                height:
                    188 +
                    (MediaQuery.textScalerOf(context).scale(1) - 1).clamp(0.0, 0.15) *
                        240,
                child: Stack(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(20),
                      child: PageView.builder(
                        controller: _hero,
                        itemCount: heroSlides.length,
                        onPageChanged: (i) => setState(() => _slide = i),
                        itemBuilder: (_, i) => MediaQuery.withClampedTextScaling(
                          maxScaleFactor: 1.15,
                          child: _HeroSlide(
                            slide: heroSlides[i],
                            onTap: () => _heroGo(heroSlides[i].go),
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 16,
                      bottom: 12,
                      child: Row(
                        children: [
                          for (var i = 0; i < heroSlides.length; i++)
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
                                          ? const Color(0xFFD9EE8C)
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
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 88),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),
              // Quick Action Banners
              Row(
                children: [
                  Expanded(
                    child: _QuickAction(
                      ctaAsset: 'assets/images/cta/home_cta_1.png',
                      icon: Icons.local_shipping_outlined,
                      label: 'Free Home Sample Collection',
                      onTap: () {
                        if (st.v1_1Mode) {
                          mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
                        } else {
                          ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _QuickAction(
                      ctaAsset: 'assets/images/cta/home_cta_2.png',
                      icon: Icons.upload_outlined,
                      label: 'Upload Prescription',
                      onTap: () => mhnPush<void>(
                        context,
                        const MhnPrescriptionScreen(),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              const _HealthAdvisorCard(),
              const SizedBox(height: 22),
              _SectionTitle(
                'Popular tests',
                action: 'See all',
                onAction: () {
                  if (st.v1_1Mode) {
                    mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
                  } else {
                    ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  }
                },
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
              const SizedBox(height: 20),
              const _CategoryOfferCards(),
              const SizedBox(height: 18),
              const _CampaignBanner(),
              const SizedBox(height: 22),
              _SectionTitle(
                'Health Concerns',
                action: 'See all',
                onAction: () => mhnPush<void>(context, const MhnPackagesScreen()),
              ),
              const SizedBox(height: 10),
              const _HealthConcernsRow(),
              const SizedBox(height: 22),
              _SectionTitle(
                'Lifestyle Concerns',
                action: 'See all',
                onAction: () => mhnPush<void>(context, const MhnPackagesScreen()),
              ),
              const SizedBox(height: 10),
              const _LifestyleConcernsRow(),
              const SizedBox(height: 22),
              _SectionTitle(
                'Allergy Tests',
                action: 'See all',
                onAction: () => mhnPush<void>(context, const MhnPackagesScreen()),
              ),
              const SizedBox(height: 10),
              const _AllergyTestsRow(),
              const SizedBox(height: 22),
              _SectionTitle(
                'Tests by category',
                action: 'See all',
                onAction: () {
                  if (st.v1_1Mode) {
                    mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
                  } else {
                    ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  }
                },
              ),
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
              _SectionTitle(
                'Routine Health Checkup for Men',
                action: 'See all',
                onAction: () {
                  if (st.v1_1Mode) {
                    mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
                  } else {
                    ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  }
                },
              ),
              const SizedBox(height: 10),
              const _AgeRow(gender: 'men'),
              const SizedBox(height: 22),
              _SectionTitle(
                'Routine Health Checkup for Women',
                action: 'See all',
                onAction: () {
                  if (st.v1_1Mode) {
                    mhnPush<void>(context, const MhnPage(title: 'All Tests', child: MhnTestsTab()));
                  } else {
                    ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  }
                },
              ),
              const SizedBox(height: 10),
              const _AgeRow(gender: 'women'),
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
                    for (final p in catalog.packages)
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
              _SectionTitle(
                'Tests by organ',
                action: 'See all',
                onAction: () => mhnPush<void>(
                  context,
                  MhnCategoryScreen(
                    category: kCategories.firstWhere((c) => c.id == 'organs'),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              const _OrganTestsRow(),
              const SizedBox(height: 20),
              const _SupplementsStrip(),
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
          ),
        ),
      ],
    );
  }
}

class _CategoryOfferCards extends ConsumerWidget {
  const _CategoryOfferCards();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = [
      ('Blood Tests', '79% Off*', Icons.bloodtype_outlined, const Color(0xFFC62828)),
      ('Specialized Tests', '70% Off*', Icons.biotech_outlined, const Color(0xFF00897B)),
      ('Popular Packages', '84% Off*', Icons.shield_outlined, const Color(0xFF1E88E5)),
    ];
    return Row(
      children: [
        for (var i = 0; i < items.length; i++) ...[
          if (i > 0) const SizedBox(width: 8),
          Expanded(
            child: Material(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              elevation: 1,
              shadowColor: Colors.black12,
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () {
                  if (i == 2) {
                    mhnPush<void>(context, const MhnPackagesScreen());
                  } else {
                    ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  }
                },
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: Stack(
                    children: [
                      Positioned(
                        left: -16,
                        top: 6,
                        child: Transform.rotate(
                          angle: -0.785,
                          child: Container(
                            width: 64,
                            alignment: Alignment.center,
                            color: const Color(0xFFE53935),
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Text(
                              items[i].$2,
                              style: Mhn.t(8, w: FontWeight.w800, c: Colors.white),
                            ),
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(6, 18, 6, 10),
                        child: Column(
                          children: [
                            Container(
                              width: 38,
                              height: 38,
                              decoration: const BoxDecoration(
                                color: Color(0xFFE8F4EC),
                                shape: BoxShape.circle,
                              ),
                              child: Icon(items[i].$3, color: items[i].$4, size: 20),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              items[i].$1,
                              textAlign: TextAlign.center,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: Mhn.t(11, w: FontWeight.w700),
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
      ],
    );
  }
}

class _CampaignBanner extends StatelessWidget {
  const _CampaignBanner();

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: Image.asset(
            'assets/images/cards/campaign_men.jpg',
            width: double.infinity,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => const SizedBox(),
          ),
        ),
      ),
    );
  }
}

class _HealthConcernsRow extends StatelessWidget {
  const _HealthConcernsRow();

  @override
  Widget build(BuildContext context) {
    final concerns = [
      ('Fatigue', 'assets/images/cards/concern_fatigue.jpg'),
      ('Acidity', 'assets/images/cards/concern_acidity.jpg'),
      ('Anemia', 'assets/images/avatars/anika.jpg'),
      ('Diabetes', 'assets/images/avatars/ramesh.jpg'),
      ('Thyroid', 'assets/images/avatars/sunita.jpg'),
    ];
    return SizedBox(
      height: 180,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: concerns.length,
        separatorBuilder: (_, __) => const SizedBox(width: 12),
        itemBuilder: (context, i) {
          final c = concerns[i];
          return Container(
            width: 125,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: const [
                BoxShadow(color: Color(0x10000000), blurRadius: 8, offset: Offset(0, 3)),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Image.asset(
                      c.$2,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(color: const Color(0xFFE8F4EC)),
                    ),
                  ),
                  Positioned.fill(
                    child: Container(
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Colors.transparent, Color(0x33000000), Color(0xCC084D3B)],
                          stops: [0.35, 0.65, 1.0],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    bottom: 10,
                    left: 8,
                    right: 8,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          c.$1,
                          style: Mhn.t(13, w: FontWeight.w700, c: Colors.white),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 6),
                        InkWell(
                          onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
                          child: Container(
                            width: double.infinity,
                            height: 28,
                            decoration: BoxDecoration(
                              border: Border.all(color: Colors.white),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              'Book Now',
                              style: Mhn.t(11, w: FontWeight.w700, c: Colors.white),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _LifestyleConcernsRow extends StatelessWidget {
  const _LifestyleConcernsRow();

  @override
  Widget build(BuildContext context) {
    final items = [
      ('Alcohol', 'assets/images/cards/lifestyle_alcohol.jpg'),
      ('Diet', 'assets/images/cards/lifestyle_diet.jpg'),
      ('Anger / Stress', 'assets/images/cards/lifestyle_anger.jpg'),
      ('Sedentary', 'assets/images/avatars/men.jpg'),
    ];
    return SizedBox(
      height: 180,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(width: 12),
        itemBuilder: (context, i) {
          final it = items[i];
          return Container(
            width: 125,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: const [
                BoxShadow(color: Color(0x10000000), blurRadius: 8, offset: Offset(0, 3)),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Image.asset(
                      it.$2,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => Container(color: const Color(0xFFE8F4EC)),
                    ),
                  ),
                  Positioned.fill(
                    child: Container(
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Colors.transparent, Color(0x33000000), Color(0xCC084D3B)],
                          stops: [0.35, 0.65, 1.0],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    bottom: 10,
                    left: 8,
                    right: 8,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          it.$1,
                          style: Mhn.t(13, w: FontWeight.w700, c: Colors.white),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 6),
                        InkWell(
                          onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
                          child: Container(
                            width: double.infinity,
                            height: 28,
                            decoration: BoxDecoration(
                              border: Border.all(color: Colors.white),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              'Book Now',
                              style: Mhn.t(11, w: FontWeight.w700, c: Colors.white),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _AllergyTestsRow extends StatelessWidget {
  const _AllergyTestsRow();

  @override
  Widget build(BuildContext context) {
    final allergies = [
      ('VEG & NON VEG', 'assets/images/cards/allergy_food.jpg'),
      ('DRUGS', 'assets/images/cards/allergy_drugs.jpg'),
      ('PETS', 'assets/images/cards/allergy_pets.jpg'),
    ];
    return Row(
      children: [
        for (var i = 0; i < allergies.length; i++) ...[
          if (i > 0) const SizedBox(width: 10),
          Expanded(
            child: Container(
              height: 124,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: const Color(0xFFE2EBE5), width: 1.0),
                boxShadow: const [
                  BoxShadow(color: Color(0x10000000), blurRadius: 8, offset: Offset(0, 3)),
                ],
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Image.asset(
                        allergies[i].$2,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Container(color: const Color(0xFFE8F4EC)),
                      ),
                    ),
                    Positioned.fill(
                      child: Container(
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Colors.transparent,
                              Color(0x33000000),
                              Color(0xCC084D3B),
                            ],
                            stops: [0.30, 0.65, 1.0],
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      bottom: 8,
                      left: 4,
                      right: 4,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            allergies[i].$1,
                            style: Mhn.t(10, w: FontWeight.w800, c: Colors.white),
                            textAlign: TextAlign.center,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 4),
                          InkWell(
                            onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
                            child: Container(
                              width: double.infinity,
                              height: 22,
                              decoration: BoxDecoration(
                                border: Border.all(color: Colors.white),
                                borderRadius: BorderRadius.circular(11),
                              ),
                              alignment: Alignment.center,
                              child: Text(
                                'Book Now',
                                style: Mhn.t(9, w: FontWeight.w700, c: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Positioned.fill(
                      child: Material(
                        color: Colors.transparent,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(14),
                          onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _HealthAdvisorCard extends StatelessWidget {
  const _HealthAdvisorCard();

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => MhnCallSheet.show(context),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: Image.asset(
            'assets/images/cta/detail_cta_1.png',
            width: double.infinity,
            height: 98,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: const Color(0xFFEBF6F0),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: const BoxDecoration(
                      color: Mhn.green,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.support_agent, color: Mhn.white, size: 20),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Doctor Post-report consultation',
                          style: Mhn.t(14, w: FontWeight.w700, c: Mhn.ink),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Free teleconsultation with certified doctors & dietitians.',
                          style: Mhn.t(12, c: Mhn.muted),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, color: Mhn.green, size: 22),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _OrganTestsRow extends StatelessWidget {
  const _OrganTestsRow();

  @override
  Widget build(BuildContext context) {
    final organs = [
      ('Heart', Icons.favorite, const Color(0xFFE53935)),
      ('Liver', Icons.healing, const Color(0xFF8E24AA)),
      ('Kidney', Icons.water_drop, const Color(0xFF1E88E5)),
      ('Thyroid', Icons.record_voice_over, const Color(0xFFFB8C00)),
      ('Lungs', Icons.air, const Color(0xFF00897B)),
    ];
    return SizedBox(
      height: 86,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: organs.length,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (_, i) => MediaQuery.withClampedTextScaling(
          maxScaleFactor: 1.15,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () {
                final organName = organs[i].$1.toLowerCase();
                if (organName == 'heart') {
                  final t = kTests.firstWhere((x) => x.id == 'lipid', orElse: () => kTests.first);
                  mhnPush<void>(context, MhnTestDetailScreen(test: t));
                } else if (organName == 'liver') {
                  final t = kTests.firstWhere((x) => x.id == 'lft', orElse: () => kTests.first);
                  mhnPush<void>(context, MhnTestDetailScreen(test: t));
                } else if (organName == 'kidney') {
                  final t = kTests.firstWhere((x) => x.id == 'kft', orElse: () => kTests.first);
                  mhnPush<void>(context, MhnTestDetailScreen(test: t));
                } else if (organName == 'thyroid') {
                  final t = kTests.firstWhere((x) => x.id == 'tft', orElse: () => kTests.first);
                  mhnPush<void>(context, MhnTestDetailScreen(test: t));
                } else {
                  final cat = kCategories.firstWhere((c) => c.id == 'organs');
                  mhnPush<void>(context, MhnCategoryScreen(category: cat));
                }
              },
              child: Container(
                width: 76,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: Mhn.line),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(organs[i].$2, color: organs[i].$3, size: 28),
                    const SizedBox(height: 6),
                    Text(
                      organs[i].$1,
                      style: Mhn.t(12, w: FontWeight.w700),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SupplementsStrip extends StatelessWidget {
  const _SupplementsStrip();

  @override
  Widget build(BuildContext context) {
    final supplements = [
      ('DIABEAT-EASE', 'Rs. 1,035', '55% OFF', const Color(0xFF2E7D32)),
      ('CALCI BUILD', 'Rs. 557', '55% OFF', const Color(0xFF00695C)),
      ('CHOLEST-GUARD', 'Rs. 899', '45% OFF', const Color(0xFF1565C0)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Herbवेद+™',
                style: Mhn.t(18, w: FontWeight.w800, c: const Color(0xFF084D3B)),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => mhnPush<void>(context, const HerbSupplementsScreen()),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Text('Explore Now >', style: Mhn.t(13, w: FontWeight.w700, c: const Color(0xFFE53935))),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 140,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: supplements.length,
            separatorBuilder: (_, __) => const SizedBox(width: 12),
            itemBuilder: (_, i) {
              final s = supplements[i];
              return MediaQuery.withClampedTextScaling(
                maxScaleFactor: 1.15,
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () => mhnPush<void>(context, const HerbSupplementsScreen()),
                    child: Container(
                      width: 130,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: Mhn.line),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Center(
                              child: Container(
                                width: 44,
                                height: 44,
                                decoration: BoxDecoration(
                                  color: s.$4.withAlpha(30),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Icon(Icons.medication_liquid_outlined, color: s.$4, size: 28),
                              ),
                            ),
                          ),
                          Text(s.$1, style: Mhn.t(11, w: FontWeight.w800), maxLines: 1),
                          Row(
                            children: [
                              Flexible(
                                child: Text(
                                  s.$2,
                                  style: Mhn.t(12, w: FontWeight.w700),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              const SizedBox(width: 4),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFFFEBEE),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(s.$3, style: Mhn.t(9, w: FontWeight.w700, c: const Color(0xFFC62828))),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
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
  Widget build(BuildContext context) {
    return Mhn3DTiltCard(
      borderRadius: 20,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Container(
          color: const Color(0xFF084D3B),
          child: Stack(
        children: [
          if (slide.imageUrl.isNotEmpty)
            Positioned.fill(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: Image.network(
                  slide.imageUrl,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => slide.imageAsset.isNotEmpty
                      ? Image.asset(slide.imageAsset, fit: BoxFit.cover)
                      : const SizedBox(),
                ),
              ),
            )
          else if (slide.imageAsset.isNotEmpty)
            Positioned.fill(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: Image.asset(
                  slide.imageAsset,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox(),
                ),
              ),
            ),
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                gradient: const LinearGradient(
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                  colors: [
                    Color(0xFF063226),
                    Color(0xF6063226),
                    Color(0xB8063226),
                    Color(0x40063226),
                    Colors.transparent,
                  ],
                  stops: [0.0, 0.44, 0.62, 0.78, 0.92],
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
                  decoration: BoxDecoration(
                    color: Mhn.lime,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    slide.tag,
                    style: Mhn.t(9.5, w: FontWeight.w800, c: Mhn.green),
                  ),
                ),
                const SizedBox(height: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 200),
                  child: Text(
                    slide.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Mhn.t(16, w: FontWeight.w800, c: Mhn.white, h: 1.2),
                  ),
                ),
                const SizedBox(height: 2),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 200),
                  child: Text(
                    slide.sub,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Mhn.t(11.5, c: Mhn.white.withAlpha(200)),
                  ),
                ),
                const Spacer(),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    SizedBox(
                      height: 30,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Mhn.lime,
                          foregroundColor: Mhn.green,
                          padding: const EdgeInsets.symmetric(horizontal: 11),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                          elevation: 0,
                        ),
                        onPressed: onTap,
                        child: Text(
                          slide.cta,
                          style: Mhn.t(11.5, w: FontWeight.w800, c: Mhn.green),
                        ),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
                      decoration: BoxDecoration(
                        color: Colors.white12,
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        '100% Barcoded',
                        style: Mhn.t(10.5, w: FontWeight.w600, c: Colors.white70),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
      ],
    ),
  ),
),
);
  }
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.ctaAsset,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final String? ctaAsset;

  @override
  Widget build(BuildContext context) {
    if (ctaAsset != null) {
      return Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Image.asset(
              ctaAsset!,
              fit: BoxFit.cover,
              height: 64,
              errorBuilder: (_, __, ___) => _fallback(),
            ),
          ),
        ),
      );
    }
    return _fallback();
  }

  Widget _fallback() => Material(
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
        Semantics(
          button: true,
          label: '$action for $text',
          child: InkWell(
            onTap: onAction,
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Text(
                action!,
                style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green),
              ),
            ),
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
            child: Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => mhnPush<void>(context, MhnTestDetailScreen(test: test)),
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
                  ],
                ),
              ),
            ),
          ),
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
  const _AgeRow({this.gender = 'men'});
  final String gender;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isMen = gender == 'men';
    final items = isMen
        ? const [
            ('20–30', 'years', 'assets/images/avatars/aarav.jpg'),
            ('31–40', 'years', 'assets/images/avatars/men.jpg'),
            ('41–50', 'years', 'assets/images/avatars/men_41_50.jpg'),
            ('51–60', 'years', 'assets/images/avatars/men_51_60.jpg'),
            ('60+', 'years', 'assets/images/avatars/men_60_plus.jpg'),
          ]
        : const [
            ('20–30', 'years', 'assets/images/avatars/anika.jpg'),
            ('31–40', 'years', 'assets/images/avatars/women_31_40.jpg'),
            ('41–50', 'years', 'assets/images/avatars/women_41_50.jpg'),
            ('51–60', 'years', 'assets/images/avatars/women_51_60.jpg'),
            ('60+', 'years', 'assets/images/avatars/women_60_plus.jpg'),
          ];

    return SizedBox(
      height: 114,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: items.length,
        padding: const EdgeInsets.symmetric(horizontal: 2),
        separatorBuilder: (_, __) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final it = items[i];
          return MediaQuery.withClampedTextScaling(
            maxScaleFactor: 1.15,
            child: Container(
              width: 72,
              decoration: BoxDecoration(
                color: Mhn.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Mhn.line),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x0A000000),
                    blurRadius: 5,
                    offset: Offset(0, 2),
                  ),
                ],
              ),
              child: Material(
                color: Colors.transparent,
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => mhnPush<void>(context, const MhnPackagesScreen()),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(color: const Color(0xFF1B6B52), width: 1.5),
                          ),
                          child: ClipOval(
                            child: Image.asset(
                              it.$3,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => const Icon(
                                Icons.person,
                                color: Mhn.green,
                                size: 26,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 5),
                        Text(
                          it.$1,
                          style: Mhn.t(11, w: FontWeight.w800),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          it.$2,
                          style: Mhn.t(10, c: Mhn.muted),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// H02 City / Service Location selection bottom sheet (E31 listMyBookingCentres).
Future<void> showCitySelectionSheet(BuildContext context, WidgetRef ref) async {
  final centres = <Map<String, Object?>>[
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
    {
      'centre_id': '01950c16-0000-7000-8000-000000000033',
      'display_name': 'MetroLabs Baluwatar',
      'address_text': 'Baluwatar, Kathmandu',
    },
    {
      'centre_id': '01950c16-0000-7000-8000-000000000034',
      'display_name': 'MetroLabs Bhaktapur',
      'address_text': 'Suryabinayak, Bhaktapur',
    },
  ];

  if (!context.mounted) return;

  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: Mhn.white,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (ctx) {
      final current = ref.watch(mhnProvider).selectedLocationLabel;
      return SafeArea(
        child: SingleChildScrollView(
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
              const SizedBox(height: 14),

              // 1. Live Location Button (Native GPS & Permission Handler)
              InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  final pos = await MhnLocationService.getCurrentPosition(
                    onError: (err) => mhnToast(context, err),
                  );
                  if (pos != null) {
                    final label = MhnLocationService.formatLocation(pos);
                    ref.read(mhnProvider.notifier).setSelectedLocation(
                      locationLabel: label,
                    );
                    mhnToast(context, '📍 Live GPS location set: $label');
                  } else {
                    ref.read(mhnProvider.notifier).setSelectedLocation(
                      locationLabel: 'Baneshwor, Kathmandu',
                    );
                  }
                },
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F8F5),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: const Color(0xFFC7E27A)),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: const BoxDecoration(
                          color: Color(0xFF0E4B3B),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.my_location, size: 18, color: Colors.white),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Use Current Location', style: Mhn.t(14, w: FontWeight.w700, c: const Color(0xFF0E4B3B))),
                            const SizedBox(height: 2),
                            Text('Detect via GPS (Live Geolocation)', style: Mhn.t(11.5, c: Mhn.muted)),
                          ],
                        ),
                      ),
                      const Icon(Icons.chevron_right, color: Color(0xFF0E4B3B)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),

              // 2. Pick on Google Map Button
              InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () async {
                  Navigator.of(ctx).pop();
                  final picked = await MhnMapPickerScreen.pick(context);
                  if (picked != null) {
                    ref.read(mhnProvider.notifier).setSelectedLocation(
                      locationLabel: '${picked.locality}, ${picked.city}',
                    );
                    ref.read(mhnProvider.notifier).setAddress(picked.formattedAddress);
                    mhnToast(context, '📍 Location picked: ${picked.locality}');
                  }
                },
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: const Color(0xFFDADCE0)),
                  ),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: const Color(0xFFEA4335).withValues(alpha: 0.12),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.map_outlined, size: 18, color: Color(0xFFEA4335)),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Pick on Google Map', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.ink)),
                            const SizedBox(height: 2),
                            Text('Pin exact doorstep on Google Maps', style: Mhn.t(11.5, c: Mhn.muted)),
                          ],
                        ),
                      ),
                      const Icon(Icons.chevron_right, color: Mhn.muted),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text('Or select service area on app:', style: Mhn.t(13, w: FontWeight.w700, c: Mhn.ink)),
              const SizedBox(height: 6),
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
