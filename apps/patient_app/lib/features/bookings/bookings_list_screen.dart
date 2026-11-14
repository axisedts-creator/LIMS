// A16 Bookings list (04-UI-UX A16; 03-APP-FLOW §11 Bookings row; US-EN-14.1). Fetches E34 on open, on pull-to-refresh and on return from a booking; infinite scroll by cursor.
// LD-140: lims_ui components and token names only; one primary button ([Book a test]). REQ-SEC-109: LimsSecureScreen. PHI stays in widget state (never persisted / logged); server detail is never shown.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'booking_detail_screen.dart';
import 'booking_wizard_screen.dart';
import 'bookings_api.dart';
import 'bookings_format.dart';
import 'bookings_providers.dart';

class BookingsListScreen extends ConsumerStatefulWidget {
  const BookingsListScreen({super.key});

  @override
  ConsumerState<BookingsListScreen> createState() => _BookingsListScreenState();
}

class _BookingsListScreenState extends ConsumerState<BookingsListScreen> {
  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  List<Map<String, Object?>> _rows = const [];
  String? _cursor;
  bool _busy = false, _failed = false, _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    if (_busy) return;
    _busy = true;
    try {
      final body = asMap(
        await _api.listBookings(cursor: more ? _cursor : null),
      );
      if (!mounted) return;
      final next = asMap(body?['page'])?['next_cursor'];
      setState(() {
        _rows = more
            ? [..._rows, ...mapList(body?['data'])]
            : mapList(body?['data']);
        _cursor = next is String ? next : null;
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted) setState(() => _failed = true); // never show server detail
    } finally {
      _busy = false;
    }
  }

  Future<void> _reload() async {
    _cursor = null;
    await _load();
  }

  Future<void> _open(Widget screen) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => screen));
    if (mounted)
      _reload(); // a cancel / reschedule / new booking changes the list
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('Bookings')),
      body: Column(
        children: [
          Expanded(child: _body()),
          Padding(
            padding: const EdgeInsets.all(LimsTokens.space4),
            child: SizedBox(
              width: double.infinity,
              child: LimsButton(
                label: 'Book a test',
                onPressed: () => _open(const BookingWizardScreen()),
              ),
            ),
          ),
        ],
      ),
    ),
  );

  Widget _body() {
    if (_rows.isEmpty) {
      if (_failed)
        return Center(
          child: LimsErrorState(
            title: 'Something went wrong',
            message: 'We could not load your bookings.',
            onRetry: _reload,
          ),
        );
      if (!_loaded) return const Center(child: CircularProgressIndicator());
      return const Center(
        child: LimsEmptyState(
          title: 'No bookings',
          message: 'Book a test to see it here.',
        ),
      );
    }
    // ponytail: plain Column (the page is <= 200 rows); switch to ListView.builder if pages grow
    return RefreshIndicator(
      onRefresh: _reload,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: Column(
          children: [
            for (final b in _rows)
              Padding(
                padding: const EdgeInsets.only(bottom: LimsTokens.space3),
                child: InkWell(
                  onTap: b['id'] is String
                      ? () => _open(
                          BookingDetailScreen(bookingId: b['id']! as String),
                        )
                      : null,
                  child: LimsCard(
                    title: placeText(b),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Booking ${b['booking_no']}'),
                        Text(dateTimeText(b['slot_start'])),
                        const SizedBox(height: LimsTokens.space2),
                        LimsStatusChip(
                          kind: 'generic',
                          status: '${b['status']}',
                          tone: bookingLook(b['status']).$1,
                          label: bookingLook(b['status']).$2,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            if (_cursor != null)
              LimsButton(
                label: 'Show more bookings',
                secondary: true,
                onPressed: () => _load(more: true),
              ),
          ],
        ),
      ),
    );
  }
}
