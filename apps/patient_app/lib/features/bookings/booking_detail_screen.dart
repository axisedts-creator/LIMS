// A18 Booking detail (04-UI-UX A18; 03-APP-FLOW §6.2, §11; US-EN-14.1-3). E35 on open; [Cancel booking] -> confirm -> E36 (If-Match = version, Idempotency-Key per attempt, reused on a retry of the same version);
// [Reschedule] opens A17 at the slot step. Both only while E35 carries cancellable_until (the server decides the cutoff). 404 = "no longer available" (AB-6).
// LD-140: lims_ui components and token names only; one primary button ([Reschedule]). REQ-SEC-109: LimsSecureScreen. PHI stays in widget state; server detail is never shown.
import 'dart:async';


import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import '../../core/session/session_controller.dart';
import '../orders/order_detail_screen.dart';
import '../orders/orders_format.dart';
import '../orders/status_look.dart';
import 'booking_wizard_screen.dart';
import 'bookings_api.dart';
import 'bookings_format.dart';
import 'bookings_providers.dart';
import '../mhn/live_collector_map.dart';

class BookingDetailScreen extends ConsumerStatefulWidget {
  const BookingDetailScreen({super.key, required this.bookingId});

  final String bookingId;

  @override
  ConsumerState<BookingDetailScreen> createState() =>
      _BookingDetailScreenState();
}

class _BookingDetailScreenState extends ConsumerState<BookingDetailScreen> {
  // shortcut: provisional 30-second foreground polling cadence; upgrade when server push is specified
  static const _interval = Duration(seconds: 30); // [CONV] order_poll_seconds default

  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  late final SessionController _session = ref.read(sessionControllerProvider);
  late final AppLifecycleListener _life;
  Timer? _timer;
  Map<String, Object?>? _booking;
  String? _homeAddress, _notice, _cancelKey;
  int? _cancelKeyVersion;
  DateTime? _checkedAt;
  bool _gone = false, _failed = false, _cancelling = false, _busy = false, _ended = false;

  @override
  void initState() {
    super.initState();
    _session.status.addListener(_onSession);
    _life = AppLifecycleListener(onStateChange: _onLifecycle);
    _startPolling();
  }

  @override
  void dispose() {
    _session.status.removeListener(_onSession);
    _life.dispose();
    _timer?.cancel();
    super.dispose();
  }

  // PHLEBO-UI-FULL-1: while the phlebotomist is on the way the position moves, so the screen asks more often.
  static const _travelInterval = Duration(seconds: 10);
  bool _fastPolling = false;

  void _startPolling() {
    _timer?.cancel();
    _fastPolling = false;
    _timer = Timer.periodic(_interval, (_) => _fetch());
    _fetch();
  }

  void _matchPollingTo(Map<String, Object?>? booking) {
    final enRoute = asMap(booking?['tracking'])?['tracking_status'] == 'en_route';
    if (enRoute == _fastPolling || _timer == null) return;
    _fastPolling = enRoute;
    _timer?.cancel();
    _timer = Timer.periodic(enRoute ? _travelInterval : _interval, (_) => _fetch());
  }

  void _stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  void _onLifecycle(AppLifecycleState s) {
    switch (s) {
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _stopPolling();
      case AppLifecycleState.resumed:
        if (!_ended && _timer == null) _startPolling();
      case AppLifecycleState.inactive:
        break;
    }
  }

  void _onSession() {
    if (_session.status.value != SessionStatus.signedOut) return;
    _ended = true; // logout / expiry: stop and wipe PHI from memory (TRD §3.5)
    _stopPolling();
    if (mounted) setState(() => _booking = null);
  }

  Future<void> _fetch() async {
    if (_busy || _ended) return;
    _busy = true;
    try {
      final b = asMap(await _api.getBooking(bookingId: widget.bookingId));
      if (!mounted || _ended) return;
      if (b == null) {
        setState(() => _failed = true);
        return;
      }
      final addressId = b['home_address_id'];
      String? text = _homeAddress;
      if (addressId is String && text == null) {
        try {
          text = mapList(asMap(await _api.listAddresses())?['data'])
              .where((a) => a['id'] == addressId)
              .map((a) => a['address_text'])
              .whereType<String>()
              .firstOrNull;
        } on Object {
          text = null; // the booking is still readable without the address line
        }
      }
      if (!mounted || _ended) return;
      _matchPollingTo(b);
      setState(() {
        _booking = b;
        _homeAddress = text;
        _checkedAt = DateTime.now();
        _failed = false;
      });
      // Stop polling when terminal state is reached
      final status = b['status'];
      if (status == 'completed' || status == 'cancelled') {
        _stopPolling();
      }
    } on LimsException catch (e) {
      if (!mounted || _ended) return;
      if (e.code == LimsErrorCodes.commonNotFound) {
        _ended = true;
        _stopPolling();
        setState(() {
          _gone = true;
          _booking = null;
        });
      } else {
        setState(() => _failed = true);
      }
    } on Object {
      if (mounted && !_ended) setState(() => _failed = true);
    } finally {
      _busy = false;
    }
  }

  Future<void> _cancel() async {
    final b = _booking;
    if (b == null || _cancelling || b['id'] is! String || b['version'] is! int)
      return;
    final ok = await LimsConfirmDialog.show(
      context,
      title: 'Cancel this booking?',
      message: 'The time will be given to someone else.',
      confirmLabel: 'Yes, cancel',
      cancelLabel: 'Keep booking',
    );
    if (ok == null || !mounted) return;
    final version = b['version']! as int;
    if (_cancelKeyVersion != version) {
      _cancelKey = newIdempotencyKey(); // a retry of the same cancel reuses the key; a changed booking is a new request
      _cancelKeyVersion = version;
    }
    setState(() {
      _cancelling = true;
      _notice = null;
    });
    try {
      final done = asMap(
        await _api.cancelBooking(
          bookingId: b['id']! as String,
          version: version,
          idempotencyKey: _cancelKey!,
        ),
      );
      if (!mounted) return;
      if (done == null) throw StateError('empty answer');
      setState(() => _booking = done);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _notice = bookingErrorText(e));
      if (e is LimsException) await _fetch(); // the booking changed (cutoff passed, version moved): show it as it is now
    } finally {
      if (mounted) setState(() => _cancelling = false);
    }
  }

  Future<void> _reschedule() async {
    final b = _booking;
    if (b == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BookingWizardScreen(rescheduleOf: b),
      ),
    );
    if (mounted) _fetch();
  }

  void _showExplainer(
    BuildContext context, {
    required String title,
    required String content,
  }) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(LimsTokens.space4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(ctx).textTheme.titleMedium),
              const SizedBox(height: LimsTokens.space2),
              Text(content),
              const SizedBox(height: LimsTokens.space3),
              LimsButton(
                label: 'Got it',
                onPressed: () => Navigator.of(ctx).pop(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHomeCollectionCard(BuildContext context, Map<String, Object?> b) {
    final tr = asMap(b['tracking']);
    final trackingStatus = tr?['tracking_status'] as String? ?? 'not_assigned';
    final locationStatus = tr?['location_status'] as String? ?? 'not_applicable';
    final statusMsg = tr?['status_message'] as String?;
    final collector = tr?['collector_display_name'] as String?;
    final (tone, label) = trackingLook(trackingStatus);
    final etaAvailable = tr?['eta_available'] == true;
    final etaMin = tr?['eta_minutes'] as int?;
    // Live position (only sent while the phlebotomist is on the way).
    final live = LivePosition.of(tr);

    return LimsCard(
      title: 'Home Collection',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ToneChip(
            LimsStatusChip(
              kind: 'generic',
              status: trackingStatus,
              tone: tone,
              label: label,
            ),
          ),
          const SizedBox(height: LimsTokens.space2),
          if (collector != null && collector.isNotEmpty) ...[
            Text(
              'Phlebotomist: $collector',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: LimsTokens.space1),
          ],
          Text(
            statusMsg ??
                'A certified phlebotomist will visit your address during the scheduled time window.',
          ),
          if (etaAvailable && etaMin != null) ...[
            const SizedBox(height: LimsTokens.space1),
            Text('Estimated arrival in $etaMin min'),
          ],
          if (live != null) ...[
            const SizedBox(height: LimsTokens.space3),
            LiveCollectorMap(position: live),
            const SizedBox(height: LimsTokens.space1),
            Text(
              locationStatus == 'delayed' ? 'Last known position, updated ${live.age(DateTime.now())}.' : 'Live position, updated ${live.age(DateTime.now())}.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ] else if (trackingStatus == 'en_route') ...[
            const SizedBox(height: LimsTokens.space2),
            const Text("The phlebotomist is on the way. Their position isn't available right now."),
          ] else if (trackingStatus == 'not_assigned' || trackingStatus == 'collector_assigned') ...[
            const SizedBox(height: LimsTokens.space2),
            const Text('Live tracking starts when the phlebotomist is on the way.'),
          ],
          if (_failed) ...[
            const SizedBox(height: LimsTokens.space2),
            ToneChip(
              const LimsStatusChip(
                kind: 'generic',
                status: 'offline',
                tone: 'warning',
                label: 'Offline — tracking paused',
              ),
            ),
            const SizedBox(height: LimsTokens.space1),
            const Text(
              'Your device is offline. Live location tracking is paused until connection is restored.',
            ),
          ],
          const SizedBox(height: LimsTokens.space3),
          Row(
            children: [
              Expanded(
                child: LimsButton(
                  label: 'Sample guide',
                  secondary: true,
                  onPressed: () => _showExplainer(
                    context,
                    title: 'How sample collection works',
                    content:
                        'Our phlebotomist uses single-use sterile supplies, verifies your identity, and labels sample tubes with secure barcodes in your presence.',
                  ),
                ),
              ),
              const SizedBox(width: LimsTokens.space2),
              Expanded(
                child: LimsButton(
                  label: 'Report timeline',
                  secondary: true,
                  onPressed: () => _showExplainer(
                    context,
                    title: 'When to expect your report',
                    content:
                        'Once received at the lab, samples are analyzed and reviewed by pathologists. You will receive an in-app notification when your report is released.',
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('Booking')),
      body: _body(context),
    ),
  );

  Widget _body(BuildContext context) {
    if (_gone)
      return const StateCard(
        LimsEmptyState(title: 'This booking is no longer available'),
      );
    final b = _booking;
    if (b == null) {
      if (_failed)
        return StateCard(
          LimsErrorState(
            title: 'Something went wrong',
            message: 'We could not load this booking.',
            onRetry: () {
              setState(() => _failed = false);
              _fetch();
            },
          ),
        );
      return const Center(child: CircularProgressIndicator());
    }
    final items = mapList(b['items']);
    final total = indicativeTotal(items);
    final until = b['cancellable_until'];
    final open = b['status'] == 'confirmed' && until is String;
    final t = Theme.of(context).textTheme;
    const gap = SizedBox(height: LimsTokens.space3);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_notice != null) ...[BookingBanner(text: _notice!), gap],
          LimsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ToneChip(
                  LimsStatusChip(
                    kind: 'generic',
                    status: '${b['status']}',
                    tone: bookingLook(b['status']).$1,
                    label: bookingLook(b['status']).$2,
                  ),
                ),
                const SizedBox(height: LimsTokens.space2),
                Text('Booking ${b['booking_no']}', style: t.titleMedium),
                const SizedBox(height: LimsTokens.space2),
                Text(dateTimeText(b['slot_start'])),
                Text(placeText(b)),
                if (b['booking_kind'] == 'home_collection' &&
                    _homeAddress != null)
                  Text(_homeAddress!),
              ],
            ),
          ),
          gap,
          LimsCard(
            title: 'Tests',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final i in items)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: LimsTokens.space1,
                    ),
                    child: Row(
                      children: [
                        Expanded(child: Text('${i['display_name']}')),
                        Text(priceText(i)),
                      ],
                    ),
                  ),
                if (total != null)
                  Padding(
                    padding: const EdgeInsets.only(top: LimsTokens.space2),
                    child: Text('Indicative total: ${rupees(total)}'),
                  ),
                const Padding(
                  padding: EdgeInsets.only(top: LimsTokens.space1),
                  child: Text('Final price is confirmed at the lab.'),
                ),
              ],
            ),
          ),
          if (b['order_id'] is String) ...[
            gap,
            LimsCard(
              title: 'Order Tracking',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Samples and lab processing have been registered for this booking.'),
                  const SizedBox(height: LimsTokens.space2),
                  LimsButton(
                    label: 'Track Order & Samples',
                    secondary: true,
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => OrderDetailScreen(orderId: b['order_id']! as String),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (b['booking_kind'] == 'home_collection') ...[
            gap,
            _buildHomeCollectionCard(context, b),
          ],
          if (open) ...[
            gap,
            LimsCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'You can cancel in the app until ${dateTimeText(until)}',
                  ),
                  const SizedBox(height: LimsTokens.space3),
                  LimsButton(
                    label: 'Reschedule',
                    onPressed: _cancelling ? null : _reschedule,
                  ),
                  const SizedBox(height: LimsTokens.space2),
                  LimsButton(
                    label: 'Cancel booking',
                    secondary: true,
                    onPressed: _cancelling ? null : _cancel,
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: LimsTokens.space2),
          if (_checkedAt != null)
            Text(
              updatedText(_checkedAt!),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          if (_failed)
            Text(
              'Could not refresh. Showing the last update.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      ),
    );
  }
}
