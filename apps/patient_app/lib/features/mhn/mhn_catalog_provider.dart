import 'dart:developer' as dev;
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../app/providers.dart';
import '../auth/auth_providers.dart';
import '../bookings/bookings_providers.dart';
import 'mhn_data.dart';

@immutable
class MhnCatalogState {
  const MhnCatalogState({
    this.isLoading = false,
    this.isServerDriven = false,
    this.appEnabled = true,
    this.bookingsEnabled = true,
    this.homeCollectionEnabled = true,
    this.paymentsEnabled = false,
    this.smartReportEnabled = false,
    this.membershipEnabled = false,
    this.supportPhone = '+977-1-5000000',
    this.allowedPrefixes = const ['+977'],
    this.calendarDisplay = 'AD',
    this.heroSlides = kHero,
    this.tests = kTests,
    this.packages = kPackages,
    this.categories = kCategories,
  });

  final bool isLoading;
  final bool isServerDriven;
  final bool appEnabled;
  final bool bookingsEnabled;
  final bool homeCollectionEnabled;
  final bool paymentsEnabled;
  final bool smartReportEnabled;
  final bool membershipEnabled;
  final String supportPhone;
  final List<String> allowedPrefixes;
  final String calendarDisplay;
  final List<MhnHeroSlide> heroSlides;
  final List<MhnTest> tests;
  final List<MhnPackage> packages;
  final List<MhnCategory> categories;

  List<MhnTest> get popularTests {
    if (tests.isEmpty) {
      return [
        for (final id in kPopularIds) kTests.firstWhere((t) => t.id == id, orElse: () => kTests.first),
      ];
    }
    final matched = <MhnTest>[];
    for (final id in kPopularIds) {
      final found = tests.where((t) => t.id == id || t.code.toLowerCase() == id.toLowerCase()).firstOrNull;
      if (found != null && !matched.contains(found)) matched.add(found);
    }
    for (final t in tests) {
      if (matched.length >= 4) break;
      if (!matched.contains(t)) matched.add(t);
    }
    return matched;
  }

  List<MhnTest> get allItems => tests;

  MhnCatalogState copyWith({
    bool? isLoading,
    bool? isServerDriven,
    bool? appEnabled,
    bool? bookingsEnabled,
    bool? homeCollectionEnabled,
    bool? paymentsEnabled,
    bool? smartReportEnabled,
    bool? membershipEnabled,
    String? supportPhone,
    List<String>? allowedPrefixes,
    String? calendarDisplay,
    List<MhnHeroSlide>? heroSlides,
    List<MhnTest>? tests,
    List<MhnPackage>? packages,
    List<MhnCategory>? categories,
  }) {
    return MhnCatalogState(
      isLoading: isLoading ?? this.isLoading,
      isServerDriven: isServerDriven ?? this.isServerDriven,
      appEnabled: appEnabled ?? this.appEnabled,
      bookingsEnabled: bookingsEnabled ?? this.bookingsEnabled,
      homeCollectionEnabled: homeCollectionEnabled ?? this.homeCollectionEnabled,
      paymentsEnabled: paymentsEnabled ?? this.paymentsEnabled,
      smartReportEnabled: smartReportEnabled ?? this.smartReportEnabled,
      membershipEnabled: membershipEnabled ?? this.membershipEnabled,
      supportPhone: supportPhone ?? this.supportPhone,
      allowedPrefixes: allowedPrefixes ?? this.allowedPrefixes,
      calendarDisplay: calendarDisplay ?? this.calendarDisplay,
      heroSlides: heroSlides ?? this.heroSlides,
      tests: tests ?? this.tests,
      packages: packages ?? this.packages,
      categories: categories ?? this.categories,
    );
  }
}

class MhnCatalogNotifier extends Notifier<MhnCatalogState> {
  @override
  MhnCatalogState build() {
    Future.microtask(() => refreshCatalog());
    return const MhnCatalogState();
  }

  Future<void> refreshCatalog() async {
    state = state.copyWith(isLoading: true);
    bool serverDriven = false;

    // 1. Fetch Tenant App Config (Dynamic features, support phone, etc.)
    try {
      final authApi = ref.read(patientAuthApiProvider);
      final rawCfg = await authApi.getAppConfig();
      if (rawCfg is Map) {
        final cfg = rawCfg.cast<String, Object?>();
        final features = cfg['features'] is Map
            ? (cfg['features'] as Map).cast<String, Object?>()
            : <String, Object?>{};

        final appOn = features['app'] == true;
        final bookOn = features['bookings'] == true;
        final homeOn = features['home_collection'] == true;
        final payOn = features['payments'] == true;
        final memOn = features['membership'] == true;
        final smartOn = features['smart_report'] == true;
        final phone = cfg['support_phone'] as String? ?? state.supportPhone;
        final prefixes = cfg['allowed_phone_prefixes'] is List
            ? (cfg['allowed_phone_prefixes'] as List).cast<String>()
            : state.allowedPrefixes;
        final cal = cfg['calendar_display'] as String? ?? state.calendarDisplay;

        state = state.copyWith(
          appEnabled: appOn,
          bookingsEnabled: bookOn,
          homeCollectionEnabled: homeOn,
          paymentsEnabled: payOn,
          membershipEnabled: memOn,
          smartReportEnabled: smartOn,
          supportPhone: phone,
          allowedPrefixes: prefixes,
          calendarDisplay: cal,
        );
        serverDriven = true;
      }
    } catch (e, st) {
      dev.log('MhnCatalog: getAppConfig error (fallback to local)', error: e, stackTrace: st);
    }

    // 2. Fetch Dynamic Bookable Items (Tests & Packages from Database)
    try {
      final bookingsApi = ref.read(patientBookingsApiProvider);
      final rawItems = await bookingsApi.listBookableItems(bookingKind: 'centre_visit');
      if (rawItems is Map) {
        final map = rawItems.cast<String, Object?>();
        final data = map['data'] is List ? (map['data'] as List).cast<Map<String, Object?>>() : null;
        if (data != null && data.isNotEmpty) {
          final serverTests = <MhnTest>[];
          final serverPackages = <MhnPackage>[];

          for (final item in data) {
            final kind = item['kind'] as String? ?? 'test';
            if (kind == 'panel') {
              serverPackages.add(MhnPackage.fromBookable(item));
              serverTests.add(MhnTest.fromBookable(item));
            } else {
              serverTests.add(MhnTest.fromBookable(item));
            }
          }

          if (serverTests.isNotEmpty) {
            state = state.copyWith(
              tests: serverTests,
              packages: serverPackages.isNotEmpty ? serverPackages : state.packages,
            );
            serverDriven = true;
          }
        }
      }
    } catch (e, st) {
      dev.log('MhnCatalog: listBookableItems error (fallback to local)', error: e, stackTrace: st);
    }

    // 3. Fetch Dynamic Banners (Portal Content from Database)
    try {
      final transport = ref.read(transportProvider);
      final rawContent = await transport('GET', '/v1/engagement/me/portal-content', query: {'kind': 'banner'});
      if (rawContent is Map) {
        final map = rawContent.cast<String, Object?>();
        final data = map['data'] is List ? (map['data'] as List).cast<Map<String, Object?>>() : null;
        if (data != null && data.isNotEmpty) {
          final slides = data.map((m) => MhnHeroSlide.fromPortalContent(m)).toList();
          state = state.copyWith(heroSlides: slides);
          serverDriven = true;
        }
      }
    } catch (e) {
      // Content may require sign-in or edge routing; falls back cleanly to kHero
    }

    state = state.copyWith(
      isLoading: false,
      isServerDriven: serverDriven,
    );
  }
}

final mhnCatalogProvider = NotifierProvider<MhnCatalogNotifier, MhnCatalogState>(
  MhnCatalogNotifier.new,
);
