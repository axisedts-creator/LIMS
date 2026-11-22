// Tests for MhnTestsTab real LIMS API integration (E30 listMyBookableItems).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';
import 'package:patient_app/features/mhn/tests_tab.dart';

import '../../support/bookings_fakes.dart';

Future<void> loadPoppins() async {
  final loader = FontLoader('Poppins');
  for (final f in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    final file = File('../../packages/ui-flutter/assets/fonts/Poppins-$f.ttf');
    if (file.existsSync()) {
      loader.addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())));
    }
  }
  await loader.load();
}

class PagingFakeBookingsApi extends FakeBookingsApi {
  Object? Function(String kind, String? query, String? cursor, int? limit)? onItemsWithCursor;

  @override
  Future<Object?> listBookableItems({
    required String bookingKind,
    String? query,
    String? cursor,
    int? limit,
  }) async {
    itemCalls.add((kind: bookingKind, query: query, cursor: cursor, limit: limit));
    if (onItemsWithCursor != null) {
      return onItemsWithCursor!(bookingKind, query, cursor, limit);
    }
    return onItems(bookingKind, query);
  }
}

void main() {
  setUpAll(loadPoppins);

  late PagingFakeBookingsApi api;

  setUp(() {
    api = PagingFakeBookingsApi();
  });

  Widget buildScope({required FakeBookingsApi bookingsApi, Widget? child}) {
    return ProviderScope(
      overrides: [
        patientBookingsApiProvider.overrideWithValue(bookingsApi),
      ],
      child: MaterialApp(
        theme: LimsTheme.light(),
        home: Scaffold(body: child ?? const MhnTestsTab()),
      ),
    );
  }

  Future<void> setupViewport(WidgetTester t) async {
    t.view.physicalSize = const Size(400, 1600);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
  }

  testWidgets('fetches and displays server bookable items (E30) with server-authoritative prices', (t) async {
    await setupViewport(t);
    api.onItems = (kind, query) => {
      'data': [
        bookable(oCbc, 'test', 'Complete Blood Count', price: 45000),
        bookable(oGlu, 'test', 'Glucose Fasting', price: 20000),
        bookable(oWhp, 'panel', 'Womens Health Package', price: 250000, sex: 'female'),
      ],
      'page': {'limit': 50},
    };

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(api.itemCalls.length, 1);
    expect(api.itemCalls.first.kind, 'home_collection');

    // Server-provided display names and authoritative prices
    expect(find.text('Complete Blood Count'), findsOneWidget);
    expect(find.text('Rs 450'), findsOneWidget);

    expect(find.text('Glucose Fasting'), findsOneWidget);
    expect(find.text('Rs 200'), findsOneWidget);

    expect(find.text('Womens Health Package'), findsOneWidget);
    expect(find.text('Rs 2,500'), findsOneWidget);
    expect(find.text('Package'), findsOneWidget);
    expect(find.text('Female only'), findsOneWidget);
  });

  testWidgets('switching booking kind to Centre visit queries API with centre_visit', (t) async {
    await setupViewport(t);
    api.onItems = (kind, query) => {
      'data': [
        bookable(oCbc, 'test', 'Complete Blood Count', price: 45000),
      ],
      'page': {'limit': 50},
    };

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(api.itemCalls.last.kind, 'home_collection');

    // Tap Centre visit pill
    await t.tap(find.text('Centre visit'));
    await t.pumpAndSettle();

    expect(api.itemCalls.last.kind, 'centre_visit');
  });

  testWidgets('pagination: displays Load more button when next_cursor is present', (t) async {
    await setupViewport(t);
    var callCount = 0;
    api.onItemsWithCursor = (bookingKind, query, cursor, limit) {
      callCount++;
      if (cursor == null) {
        return {
          'data': [
            bookable(oCbc, 'test', 'Page 1 Item', price: 45000),
          ],
          'page': {'limit': 1, 'next_cursor': 'cursor_page_2'},
        };
      } else {
        return {
          'data': [
            bookable(oGlu, 'test', 'Page 2 Item', price: 20000),
          ],
          'page': {'limit': 1},
        };
      }
    };

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(find.text('Page 1 Item'), findsOneWidget);
    expect(find.text('Load more tests'), findsOneWidget);

    // Tap Load more
    await t.tap(find.text('Load more tests'));
    await t.pumpAndSettle();

    expect(callCount, 2);
    expect(api.itemCalls.last.cursor, 'cursor_page_2');
    expect(find.text('Page 1 Item'), findsOneWidget);
    expect(find.text('Page 2 Item'), findsOneWidget);
    expect(find.text('Load more tests'), findsNothing);
  });

  testWidgets('unauthorized error displays sign-in prompt', (t) async {
    await setupViewport(t);
    api.onItems = (kind, query) => throw LimsException(LimsErrorCodes.authUnauthenticated);

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(find.text('Sign in required'), findsOneWidget);
    expect(find.textContaining('Please sign in to view available tests'), findsOneWidget);
  });

  testWidgets('feature-disabled error displays service unavailable message', (t) async {
    await setupViewport(t);
    api.onItems = (kind, query) => throw LimsException(LimsErrorCodes.commonFeatureDisabled);

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(find.text('Service Unavailable'), findsOneWidget);
    expect(find.textContaining('Test bookings are currently unavailable'), findsOneWidget);
  });

  testWidgets('network error displays retry button which retries on tap', (t) async {
    await setupViewport(t);
    var failed = true;
    api.onItems = (kind, query) {
      if (failed) throw const SocketException('Connection refused');
      return {
        'data': [bookable(oCbc, 'test', 'Recovered Test', price: 30000)],
        'page': {'limit': 50},
      };
    };

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(find.text('Unable to load tests'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    failed = false;
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();

    expect(find.text('Recovered Test'), findsOneWidget);
    expect(find.text('Rs 300'), findsOneWidget);
  });

  testWidgets('adding server item to cart registers cart item and updates button state', (t) async {
    await setupViewport(t);
    api.onItems = (kind, query) => {
      'data': [
        bookable(oCbc, 'test', 'Complete Blood Count', price: 45000),
      ],
      'page': {'limit': 50},
    };

    await t.pumpWidget(buildScope(bookingsApi: api));
    await t.pumpAndSettle();

    expect(find.text('Add to cart'), findsOneWidget);

    await t.tap(find.text('Add to cart'));
    await t.pump();

    expect(find.text('Added ✓ · Tap to remove'), findsOneWidget);

    // Verify cartItemOf resolves the server item
    final cartItem = cartItemOf(oCbc);
    expect(cartItem.name, 'Complete Blood Count');
    expect(cartItem.price, 450);
  });
}
