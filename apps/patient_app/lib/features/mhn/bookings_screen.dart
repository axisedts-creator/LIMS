// My bookings: connected to E34 listMyBookings with filter tabs (Upcoming, Past, Cancelled)
// matching wireframe screens S26, S26a, S26b, S26c. Tapping opens S27 BookingDetailScreen (E35/E36).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bookings/booking_detail_screen.dart';
import '../bookings/bookings_api.dart';
import '../bookings/bookings_format.dart';
import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnBookingsScreen extends ConsumerStatefulWidget {
  const MhnBookingsScreen({super.key, this.isTab = false});
  final bool isTab;

  @override
  ConsumerState<MhnBookingsScreen> createState() => _MhnBookingsScreenState();
}

class _MhnBookingsScreenState extends ConsumerState<MhnBookingsScreen> {
  int _tab = 0; // 0: Upcoming (S26), 1: Past (S26a), 2: Cancelled (S26b)
  List<Map<String, Object?>> _serverRows = const [];
  String? _cursor;
  bool _busy = false, _failed = false, _loaded = false;
  int _gen = 0;

  PatientBookingsApi? _getApi() {
    try {
      return ref.read(patientBookingsApiProvider);
    } catch (_) {
      return null;
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    final api = _getApi();
    if (api == null) {
      if (mounted) setState(() { _loaded = true; _failed = true; });
      return;
    }
    if (_busy) return;
    final gen = more ? _gen : ++_gen;
    _busy = true;
    try {
      final body = asMap(
        await api.listBookings(cursor: more ? _cursor : null),
      );
      if (!mounted || gen != _gen) return;
      final next = asMap(body?['page'])?['next_cursor'];
      setState(() {
        _serverRows = more
            ? [..._serverRows, ...mapList(body?['data'])]
            : mapList(body?['data']);
        _cursor = next is String ? next : null;
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted && gen == _gen) {
        setState(() {
          _failed = _serverRows.isEmpty;
          _loaded = true;
        });
      }
    } finally {
      if (gen == _gen) _busy = false;
    }
  }

  Future<void> _reload() {
    _cursor = null;
    return _load();
  }

  Future<void> _openDetail(String bookingId) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BookingDetailScreen(bookingId: bookingId),
      ),
    );
    if (mounted) _reload();
  }

  bool _isCancelled(Map<String, Object?> b) => b['status'] == 'cancelled';

  bool _isPast(Map<String, Object?> b) {
    if (b['status'] == 'completed') return true;
    if (_isCancelled(b)) return false;
    final slot = b['slot_start'];
    if (slot is String) {
      final dt = DateTime.tryParse(slot);
      if (dt != null && dt.isBefore(DateTime.now()) && b['status'] != 'confirmed' && b['status'] != 'checked_in') {
        return true;
      }
    }
    return false;
  }

  bool _isUpcoming(Map<String, Object?> b) => !_isCancelled(b) && !_isPast(b);

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final hasServer = _serverRows.isNotEmpty;
    final isFallback = !hasServer && st.bookings.isNotEmpty;

    // Filter server rows if available, else filter local fallback
    final activeRows = hasServer
        ? _serverRows.where((b) {
            return switch (_tab) {
              0 => _isUpcoming(b),
              1 => _isPast(b),
              _ => _isCancelled(b),
            };
          }).toList()
        : const <Map<String, Object?>>[];

    final localRows = isFallback
        ? st.bookings.reversed.where((b) {
            // Local prototype bookings are treated as upcoming unless cancelled
            return switch (_tab) {
              0 => true,
              1 => false,
              _ => false,
            };
          }).toList()
        : const <MhnBooking>[];

    final isEmpty = hasServer ? activeRows.isEmpty : (!isFallback || localRows.isEmpty);

    return MhnPage(
      title: 'My bookings',
      showBack: !widget.isTab,
      child: Column(
        children: [
          // Filter Tabs (S26 / S26a / S26b)
          Container(
            color: Mhn.white,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  MhnChip(
                    label: 'Upcoming',
                    selected: _tab == 0,
                    radius: 12,
                    onTap: () => setState(() => _tab = 0),
                  ),
                  const SizedBox(width: 8),
                  MhnChip(
                    label: 'Past',
                    selected: _tab == 1,
                    radius: 12,
                    onTap: () => setState(() => _tab = 1),
                  ),
                  const SizedBox(width: 8),
                  MhnChip(
                    label: 'Cancelled',
                    selected: _tab == 2,
                    radius: 12,
                    onTap: () => setState(() => _tab = 2),
                  ),
                ],
              ),
            ),
          ),
          if (isFallback && !kReleaseMode)
            Container(
              width: double.infinity,
              color: Mhn.warnBg,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Text(
                'Demo mode: Showing local bookings.',
                style: Mhn.t(11, w: FontWeight.w600, c: Mhn.warnFg),
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _reload,
              child: _buildList(context, isEmpty, hasServer, activeRows, localRows),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildList(
    BuildContext context,
    bool isEmpty,
    bool hasServer,
    List<Map<String, Object?>> activeRows,
    List<MhnBooking> localRows,
  ) {
    if (_busy && !_loaded) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_failed && !hasServer && localRows.isEmpty && kReleaseMode) {
      return ListView(
        padding: const EdgeInsets.all(32),
        children: [
          const SizedBox(height: 40),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const MhnIconTile(Icons.wifi_off_outlined, size: 64),
                const SizedBox(height: 16),
                Text('Could not load bookings', style: Mhn.t(17, w: FontWeight.w700)),
                const SizedBox(height: 6),
                Text('Please check your network connection and retry.', textAlign: TextAlign.center, style: Mhn.body),
                const SizedBox(height: 20),
                MhnButton(label: 'Retry', secondary: true, onPressed: _reload),
              ],
            ),
          ),
        ],
      );
    }

    if (isEmpty) {
      return ListView(
        padding: const EdgeInsets.all(32),
        children: [
          const SizedBox(height: 40),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                MhnIconTile(
                  _tab == 2 ? Icons.cancel_outlined : Icons.event_available_outlined,
                  size: 64,
                ),
                const SizedBox(height: 16),
                Text(
                  _tab == 0
                      ? 'No bookings yet'
                      : _tab == 1
                          ? 'No past bookings'
                          : 'No cancelled bookings',
                  style: Mhn.t(17, w: FontWeight.w700),
                ),
                const SizedBox(height: 6),
                Text(
                  _tab == 0
                      ? 'Your scheduled collections and lab visits will appear here.'
                      : _tab == 1
                          ? 'Completed test appointments will appear here.'
                          : 'Cancelled bookings will appear here.',
                  textAlign: TextAlign.center,
                  style: Mhn.body,
                ),
                if (_tab == 0) ...[
                  const SizedBox(height: 20),
                  MhnButton(
                    label: 'Book a test',
                    onPressed: () => ref.read(mhnTabProvider.notifier).go(mhnTabTests),
                  ),
                ],
              ],
            ),
          ),
        ],
      );
    }

    // Render list
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (hasServer) ...[
          for (final b in activeRows) _buildServerBookingCard(b),
          if (_cursor != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: MhnButton(
                label: 'Show more bookings',
                secondary: true,
                onPressed: () => _load(more: true),
              ),
            ),
        ] else ...[
          for (final b in localRows) _buildLocalBookingCard(b),
        ],
      ],
    );
  }

  Widget _buildServerBookingCard(Map<String, Object?> b) {
    final id = b['id'] is String ? b['id']! as String : '';
    final bookingNo = b['booking_no'] is String ? b['booking_no']! as String : id;
    final status = b['status'];
    final look = bookingLook(status);
    final place = placeText(b);
    final when = dateTimeText(b['slot_start']);
    final items = mapList(b['items']);
    final itemNames = items.map((i) => i['display_name']).whereType<String>().join(', ');
    final totalPaisa = indicativeTotal(items);

    final (bg, fg) = switch (look.$1) {
      'success' => (const Color(0xFFE8F5E9), const Color(0xFF1B5E20)),
      'info' => (const Color(0xFFE3F2FD), const Color(0xFF0D47A1)),
      'warning' => (Mhn.warnBg, Mhn.warnFg),
      _ => (Mhn.tint, Mhn.tintFg),
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MhnCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          borderRadius: BorderRadius.circular(Mhn.rCard),
          onTap: id.isNotEmpty ? () => _openDetail(id) : null,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        bookingNo.isNotEmpty ? 'Booking #$bookingNo' : id,
                        style: Mhn.t(13, w: FontWeight.w700, c: Mhn.muted),
                      ),
                    ),
                    MhnTag(look.$2, bg: bg, fg: fg),
                  ],
                ),
                const SizedBox(height: 6),
                Text(when.isNotEmpty ? when : 'Appointment scheduled', style: Mhn.t(16, w: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(place, style: Mhn.t(14, c: Mhn.muted)),
                if (itemNames.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(itemNames, style: Mhn.t(13, c: Mhn.muted), maxLines: 2, overflow: TextOverflow.ellipsis),
                ],
                const SizedBox(height: 8),
                Row(
                  children: [
                    Text(
                      totalPaisa != null ? rupees(totalPaisa) : 'Price at lab',
                      style: Mhn.t(15, w: FontWeight.w800),
                    ),
                    const Spacer(),
                    Text('View details ›', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.green)),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLocalBookingCard(MhnBooking b) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MhnCard(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(b.id, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.muted))),
                const MhnTag('Confirmed'),
              ],
            ),
            const SizedBox(height: 6),
            Text(b.when, style: Mhn.t(16, w: FontWeight.w800)),
            const SizedBox(height: 2),
            Text('${b.who} · ${b.mode == 'home' ? 'Home collection' : 'Centre visit'}', style: Mhn.t(14, c: Mhn.muted)),
            const SizedBox(height: 2),
            Text(b.items.join(', '), style: Mhn.t(13, c: Mhn.muted)),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(rs(b.total), style: Mhn.t(15, w: FontWeight.w800)),
                const Spacer(),
                Text(b.payLabel, style: Mhn.t(13, c: Mhn.muted)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
