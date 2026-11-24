// S30 to S32a: Live Collection Tracking, Collector Arrival, and Sample Collection Screens
// Features real-time map simulation, dynamic tracking states (delayed, lost, late, offline, reassigned),
// real photo portraits for phlebotomists (Ramesh Thapa, Sunita Rai), and sample barcode custody tracking.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'mhn_map_picker.dart';
import 'mhn_theme.dart';

enum TrackingState {
  onTheWay,
  delayed,
  locationLost,
  unavailable,
  late,
  offline,
  retrying,
  reassigned,
  waitingNewLocation,
  arrived,
  collected,
  partiallyCollected,
}

class MhnLiveTrackingScreen extends StatefulWidget {
  const MhnLiveTrackingScreen({
    super.key,
    this.initialState = TrackingState.onTheWay,
    this.bookingRef = 'MHN-10471',
  });

  final TrackingState initialState;
  final String bookingRef;

  @override
  State<MhnLiveTrackingScreen> createState() => _MhnLiveTrackingScreenState();
}

class _MhnLiveTrackingScreenState extends State<MhnLiveTrackingScreen> with SingleTickerProviderStateMixin {
  late TrackingState _state;
  late AnimationController _pulseCtrl;
  Timer? _simTimer;
  double _collectorProgress = 0.65; // along route

  @override
  void initState() {
    super.initState();
    _state = widget.initialState;
    _pulseCtrl = AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();
  }

  @override
  void dispose() {
    _simTimer?.cancel();
    _pulseCtrl.dispose();
    super.dispose();
  }

  void _callCollector(BuildContext context, String name, String phone) async {
    final uri = Uri.parse('tel:$phone');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    } else {
      if (context.mounted) mhnToast(context, 'Calling collector $name ($phone)...');
    }
  }

  void _showContactOptions(BuildContext context, String collectorName, String phone) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Mhn.white,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(color: Mhn.line, borderRadius: BorderRadius.circular(2)),
                ),
              ),
              Text('Contact your collector', style: Mhn.t(18, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(
                'Calls and messages go through MetroLabs. Your number is not shown to the collector, and theirs is not shown to you.',
                style: Mhn.t(12, c: Mhn.muted, h: 1.3),
              ),
              const SizedBox(height: 18),
              ListTile(
                leading: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(color: Mhn.tint, borderRadius: BorderRadius.circular(10)),
                  child: const Icon(Icons.phone_in_talk, color: Mhn.green),
                ),
                title: Text('Call collector', style: Mhn.t(14, w: FontWeight.w700)),
                subtitle: Text('Through a masked line', style: Mhn.t(12, c: Mhn.muted)),
                trailing: const Icon(Icons.chevron_right, color: Mhn.muted),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _callCollector(context, collectorName, phone);
                },
              ),
              const Divider(height: 1),
              ListTile(
                leading: Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(color: const Color(0xFFF0F4F8), borderRadius: BorderRadius.circular(10)),
                  child: const Icon(Icons.support_agent, color: Color(0xFF1976D2)),
                ),
                title: Text('Message support', style: Mhn.t(14, w: FontWeight.w700)),
                subtitle: Text('If no answer', style: Mhn.t(12, c: Mhn.muted)),
                trailing: const Icon(Icons.chevron_right, color: Mhn.muted),
                onTap: () {
                  Navigator.of(ctx).pop();
                  mhnToast(context, 'Connecting with MetroLabs Support...');
                },
              ),
              const SizedBox(height: 12),
              MhnButton(
                label: 'Close',
                secondary: true,
                onPressed: () => Navigator.of(ctx).pop(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_state == TrackingState.arrived) {
      return _buildCollectorArrivedView(context);
    }
    if (_state == TrackingState.collected || _state == TrackingState.partiallyCollected) {
      return _buildSampleCollectedView(context, partially: _state == TrackingState.partiallyCollected);
    }

    final isNewCollector = _state == TrackingState.reassigned || _state == TrackingState.waitingNewLocation;
    final collectorName = isNewCollector ? 'Sunita Rai' : 'Ramesh Thapa';
    final collectorId = isNewCollector ? 'MHN-PH-231' : 'MHN-PH-208';
    final collectorPhoto = isNewCollector ? 'assets/images/avatars/sunita.png' : 'assets/images/avatars/ramesh.png';

    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(70),
        child: Container(
          color: Mhn.green,
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                children: [
                  Material(
                    color: Colors.white24,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                    child: InkWell(
                      onTap: () => Navigator.of(context).maybePop(),
                      child: const SizedBox(width: 38, height: 38, child: Icon(Icons.arrow_back, color: Colors.white, size: 20)),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text('Track collection', style: Mhn.t(17, w: FontWeight.w700, c: Mhn.white)),
                      Text(widget.bookingRef, style: Mhn.t(12, c: Colors.white70)),
                    ],
                  ),
                  const Spacer(),
                  // State Switcher (for review & verification of all wireframe variants)
                  PopupMenuButton<TrackingState>(
                    icon: const Icon(Icons.tune, color: Mhn.lime, size: 22),
                    tooltip: 'Test Tracking States',
                    onSelected: (st) => setState(() => _state = st),
                    itemBuilder: (_) => [
                      const PopupMenuItem(value: TrackingState.onTheWay, child: Text('S30: Live (12 min)')),
                      const PopupMenuItem(value: TrackingState.delayed, child: Text('S30a: Location Delayed')),
                      const PopupMenuItem(value: TrackingState.locationLost, child: Text('S30d: Location Lost')),
                      const PopupMenuItem(value: TrackingState.unavailable, child: Text('S30b: Unavailable')),
                      const PopupMenuItem(value: TrackingState.late, child: Text('S30c: Collector Late')),
                      const PopupMenuItem(value: TrackingState.offline, child: Text('S30e: Offline')),
                      const PopupMenuItem(value: TrackingState.retrying, child: Text('S30f: Offline Retrying')),
                      const PopupMenuItem(value: TrackingState.reassigned, child: Text('S30g: Reassigned')),
                      const PopupMenuItem(value: TrackingState.waitingNewLocation, child: Text('S30h: New Collector Waiting')),
                      const PopupMenuItem(value: TrackingState.arrived, child: Text('S31: Collector Arrived')),
                      const PopupMenuItem(value: TrackingState.collected, child: Text('S32: Sample Collected')),
                      const PopupMenuItem(value: TrackingState.partiallyCollected, child: Text('S32a: Partially Collected')),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      body: Stack(
        children: [
          // 3D Google Maps Realtime Tracking Map
          Positioned.fill(
            bottom: 270,
            child: Stack(
              children: [
                MhnGoogleMapView(
                  initialLat: 27.6915,
                  initialLng: 85.3420,
                  zoom: 15.5,
                  showCenterPin: false,
                  showGoogleWatermark: true,
                  routePolyline: const [
                    Offset(100, 360),
                    Offset(280, 360),
                    Offset(280, 140),
                  ],
                  destinationPosition: const Offset(280, 140),
                  collectorPosition: Offset(
                    100 + (280 - 100) * _collectorProgress,
                    _collectorProgress > 0.65 ? 360 - (360 - 140) * ((_collectorProgress - 0.65) / 0.35) : 360,
                  ),
                  collectorProgress: _collectorProgress,
                ),
                // Collector on motorcycle icon overlay
                AnimatedBuilder(
                  animation: _pulseCtrl,
                  builder: (_, __) {
                    final currX = 100.0 + (180.0 * _collectorProgress.clamp(0.0, 1.0));
                    final currY = _collectorProgress > 0.65
                        ? 360.0 - (220.0 * ((_collectorProgress - 0.65) / 0.35))
                        : 360.0;
                    return Positioned(
                      left: currX - 22,
                      top: currY - 22,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          Container(
                            width: 44,
                            height: 44,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: const Color(0xFF1B6B52).withValues(alpha: 0.25 * (1.0 - _pulseCtrl.value)),
                            ),
                          ),
                          Container(
                            width: 34,
                            height: 34,
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: Color(0xFF0E4B3B),
                              boxShadow: [
                                BoxShadow(color: Color(0x33000000), blurRadius: 6, offset: Offset(0, 2)),
                              ],
                            ),
                            child: const Icon(Icons.two_wheeler, color: Colors.white, size: 18),
                          ),
                        ],
                      ),
                    );
                  },
                ),
                Positioned(
                  top: 12,
                  left: 16,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.75),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.gps_fixed, color: Color(0xFFD9EE8C), size: 14),
                        const SizedBox(width: 5),
                        Text('Live Google Maps Tracking', style: Mhn.t(11, w: FontWeight.w700, c: Colors.white)),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Sliding Tracking Sheet Card
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: Mhn.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                boxShadow: [
                  BoxShadow(color: Color(0x1E000000), blurRadius: 20, offset: Offset(0, -4)),
                ],
              ),
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
              child: SafeArea(
                top: false,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Container(
                        width: 36,
                        height: 4,
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(color: Mhn.lineStrong, borderRadius: BorderRadius.circular(2)),
                      ),
                    ),

                    // Status Pill / Alert Row
                    _buildTrackingStatusHeader(),
                    const SizedBox(height: 10),

                    // ETA / Warning message
                    _buildTrackingBodyContent(),
                    const SizedBox(height: 14),

                    // Phlebotomist Card
                    MhnCard(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      elevation: false,
                      borderColor: Mhn.line,
                      child: Row(
                        children: [
                          MhnAvatar(
                            name: collectorName,
                            imagePath: collectorPhoto,
                            radius: 22,
                            borderColor: Mhn.tintFg,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(collectorName, style: Mhn.t(14, w: FontWeight.w700)),
                                Text('Phlebotomist · $collectorId', style: Mhn.t(12, c: Mhn.muted)),
                              ],
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.phone, color: Mhn.green),
                            onPressed: () => _showContactOptions(context, collectorName, '+977-1-4200000'),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),

                    // 4-Step Progress Bar: [Assigned, On the way, Arrived, Collected]
                    _buildProgressSteps(),
                    const SizedBox(height: 14),

                    // Action buttons
                    _buildActionButtons(context),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTrackingStatusHeader() {
    switch (_state) {
      case TrackingState.onTheWay:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _badge(Icons.near_me_outlined, 'On the way', const Color(0xFFE8F4EC), Mhn.green),
            _badge(Icons.circle, 'Live · 4 s ago', const Color(0xFFF0FDF4), const Color(0xFF16A34A), iconSize: 8),
          ],
        );
      case TrackingState.delayed:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _badge(Icons.near_me_outlined, 'On the way', const Color(0xFFE8F4EC), Mhn.green),
            _badge(Icons.access_time, 'Delayed · 2 min ago', const Color(0xFFFEF3C7), const Color(0xFFD97706)),
          ],
        );
      case TrackingState.locationLost:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _badge(Icons.search_off, 'Location lost', const Color(0xFFFEF3C7), const Color(0xFFD97706)),
            _badge(Icons.history, 'Last seen 6 min ago', const Color(0xFFF3F4F6), Mhn.muted),
          ],
        );
      case TrackingState.unavailable:
        return _badge(Icons.location_disabled, 'Location unavailable', const Color(0xFFF3F4F6), Mhn.muted);
      case TrackingState.late:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _badge(Icons.warning_amber_rounded, 'Running late', const Color(0xFFFEE2E2), const Color(0xFFDC2626)),
            _badge(Icons.circle, 'Live · 8 s ago', const Color(0xFFF0FDF4), const Color(0xFF16A34A), iconSize: 8),
          ],
        );
      case TrackingState.offline:
      case TrackingState.retrying:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            _badge(Icons.airplanemode_active, 'Offline', const Color(0xFFF3F4F6), Mhn.muted),
            _badge(Icons.history, 'Last synced 7:41 AM', const Color(0xFFF3F4F6), Mhn.muted),
          ],
        );
      case TrackingState.reassigned:
        return _badge(Icons.person_pin_circle_outlined, 'Collector reassigned', const Color(0xFFE0F2FE), const Color(0xFF0284C7));
      case TrackingState.waitingNewLocation:
        return _badge(Icons.person_pin_circle_outlined, 'New collector assigned', const Color(0xFFE0F2FE), const Color(0xFF0284C7));
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _buildTrackingBodyContent() {
    switch (_state) {
      case TrackingState.onTheWay:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text('12 min', style: Mhn.t(24, w: FontWeight.w800)),
                const SizedBox(width: 6),
                Text('away', style: Mhn.t(14, c: Mhn.muted)),
              ],
            ),
            const SizedBox(height: 2),
            Text('Simulated estimate, not from the routing service.', style: Mhn.t(11, c: Mhn.mutedSoft)),
          ],
        );
      case TrackingState.delayed:
      case TrackingState.locationLost:
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0xFFFFFBEB), borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFFDE68A))),
          child: Row(
            children: [
              const Icon(Icons.info_outline, size: 18, color: Color(0xFFD97706)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Estimate hidden while location is delayed. Your collector is still assigned and on the way.',
                  style: Mhn.t(11, c: const Color(0xFF92400E)),
                ),
              ),
            ],
          ),
        );
      case TrackingState.late:
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0xFFFEF2F2), borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFFECACA))),
          child: Row(
            children: [
              const Icon(Icons.warning_amber_rounded, size: 18, color: Color(0xFFDC2626)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Your collector is running late. MetroLabs will share a new estimate. You can keep waiting or contact support.',
                  style: Mhn.t(11, c: const Color(0xFF991B1B)),
                ),
              ),
            ],
          ),
        );
      case TrackingState.offline:
      case TrackingState.retrying:
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0xFFF9FAFB), borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE5E7EB))),
          child: Text(
            _state == TrackingState.retrying
                ? 'Checking your connection... The last verified status stays on screen.'
                : 'You’re offline. This is the last status we verified. It may be out of date.',
            style: Mhn.t(11, c: Mhn.muted),
          ),
        );
      case TrackingState.reassigned:
      case TrackingState.waitingNewLocation:
        return Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0xFFF0F9FF), borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFBAE6FD))),
          child: Text(
            'New collector Sunita Rai assigned. Waiting for their location update.',
            style: Mhn.t(11, c: const Color(0xFF0369A1)),
          ),
        );
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _buildProgressSteps() {
    final isLate = _state == TrackingState.late;
    final isDone = _state == TrackingState.arrived || _state == TrackingState.collected || _state == TrackingState.partiallyCollected;
    return Row(
      children: [
        _stepNode(label: 'Assigned', active: true, done: true),
        _stepLine(done: true),
        _stepNode(label: 'On the way', active: !isDone, done: isDone, isAlert: isLate),
        _stepLine(done: isDone),
        _stepNode(label: 'Arrived', active: _state == TrackingState.arrived, done: isDone && _state != TrackingState.arrived),
        _stepLine(done: _state == TrackingState.collected || _state == TrackingState.partiallyCollected),
        _stepNode(label: 'Collected', active: _state == TrackingState.collected, done: _state == TrackingState.collected),
      ],
    );
  }

  Widget _stepNode({required String label, required bool active, required bool done, bool isAlert = false}) {
    Color bg = const Color(0xFFE5E7EB);
    Color border = const Color(0xFFD1D5DB);
    Widget child = const SizedBox.shrink();

    if (done) {
      bg = Mhn.green;
      border = Mhn.green;
      child = const Icon(Icons.check, size: 10, color: Colors.white);
    } else if (active) {
      bg = isAlert ? const Color(0xFFDC2626) : Mhn.green;
      border = isAlert ? const Color(0xFFDC2626) : Mhn.green;
      child = Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle));
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 18,
          height: 18,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle, border: Border.all(color: border, width: 1.5)),
          child: Center(child: child),
        ),
        const SizedBox(height: 4),
        Text(label, style: Mhn.t(10, w: active ? FontWeight.w700 : FontWeight.w500, c: active ? Mhn.ink : Mhn.mutedSoft)),
      ],
    );
  }

  Widget _stepLine({required bool done}) {
    return Expanded(
      child: Container(
        height: 2,
        margin: const EdgeInsets.only(bottom: 14),
        color: done ? Mhn.green : const Color(0xFFE5E7EB),
      ),
    );
  }

  Widget _buildActionButtons(BuildContext context) {
    if (_state == TrackingState.offline) {
      return Row(
        children: [
          Expanded(
            child: MhnButton(
              label: 'Contact support',
              secondary: true,
              onPressed: () => mhnToast(context, 'MetroLabs Support: +977-1-4200000'),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: MhnButton(
              label: 'Retry connection',
              onPressed: () {
                setState(() => _state = TrackingState.retrying);
                Future.delayed(const Duration(seconds: 2), () {
                  if (mounted) setState(() => _state = TrackingState.onTheWay);
                });
              },
            ),
          ),
        ],
      );
    }

    if (_state == TrackingState.retrying) {
      return MhnButton(label: 'Retrying...', busy: true, onPressed: null);
    }

    return MhnButton(
      label: 'View booking details',
      secondary: true,
      onPressed: () => Navigator.of(context).pop(),
    );
  }

  Widget _badge(IconData icon, String text, Color bg, Color fg, {double iconSize = 12}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: iconSize, color: fg),
            const SizedBox(width: 4),
            Text(text, style: Mhn.t(11, w: FontWeight.w700, c: fg)),
          ],
        ),
      );

  // S31: Collector Arrived View
  Widget _buildCollectorArrivedView(BuildContext context) {
    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: const MhnTopBar('Track collection'),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Arrival Banner
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFE8F4EC),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: const Color(0xFFBCE3C8)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.check_circle_outline, color: Mhn.green, size: 22),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Your collector has arrived', style: Mhn.t(14, w: FontWeight.w800, c: Mhn.green)),
                      const SizedBox(height: 2),
                      Text(
                        'Ramesh Thapa is at your address. GPS sharing has ended; location is no longer tracked.',
                        style: Mhn.t(12, c: Mhn.muted, h: 1.3),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Phlebotomist ID Card
          MhnCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const MhnAvatar(name: 'Ramesh Thapa', radius: 26, borderColor: Mhn.tintFg),
                    const SizedBox(width: 14),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Ramesh Thapa', style: Mhn.t(16, w: FontWeight.w700)),
                        Text('Phlebotomist · MHN-PH-208', style: Mhn.t(13, c: Mhn.muted)),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                const Divider(),
                const SizedBox(height: 8),
                Text('Ask for this staff ID and confirm the name before sharing a sample.', style: Mhn.t(12, c: Mhn.muted)),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Checklist
          MhnCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Before the sample is taken', style: Mhn.t(14, w: FontWeight.w700)),
                const SizedBox(height: 10),
                _checkItem('Check the staff ID: MHN-PH-208'),
                _checkItem('Confirm the patient’s name: Aarav Sharma'),
                _checkItem('Tell the collector if you have not fasted'),
              ],
            ),
          ),
          const SizedBox(height: 24),

          MhnButton(
            label: 'Contact collector',
            onPressed: () => _showContactOptions(context, 'Ramesh Thapa', '+977-1-4200000'),
          ),
          const SizedBox(height: 10),
          MhnButton(
            label: 'Simulate Sample Collected',
            secondary: true,
            onPressed: () => setState(() => _state = TrackingState.collected),
          ),
        ],
      ),
    );
  }

  // S32 / S32a: Sample Collected View
  Widget _buildSampleCollectedView(BuildContext context, {required bool partially}) {
    return Scaffold(
      backgroundColor: Mhn.page,
      appBar: const MhnTopBar('Collection Status', showBack: true),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Center(
            child: Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: partially ? const Color(0xFFFEF3C7) : const Color(0xFFE8F4EC),
                shape: BoxShape.circle,
              ),
              child: Icon(
                partially ? Icons.warning_amber_rounded : Icons.water_drop,
                size: 34,
                color: partially ? const Color(0xFFD97706) : Mhn.green,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            partially ? 'Collection partly completed' : 'Collection completed',
            textAlign: TextAlign.center,
            style: Mhn.t(20, w: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          Text(
            '${widget.bookingRef} · collected at 7:58 AM',
            textAlign: TextAlign.center,
            style: Mhn.t(13, c: Mhn.muted),
          ),
          const SizedBox(height: 24),

          Text('Samples collected', style: Mhn.t(15, w: FontWeight.w700)),
          const SizedBox(height: 10),

          // Blood Sample Card
          MhnCard(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(color: const Color(0xFFFDE8E8), borderRadius: BorderRadius.circular(10)),
                  child: const Icon(Icons.water_drop, color: Color(0xFFC24141), size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Blood sample', style: Mhn.t(14, w: FontWeight.w700)),
                      Text('Barcode BL-104717', style: Mhn.t(12, c: Mhn.muted)),
                      Text('Complete Blood Count, Lipid Profile', style: Mhn.t(11, c: Mhn.mutedSoft)),
                    ],
                  ),
                ),
                MhnTag('Collected', bg: Mhn.tint, fg: Mhn.tintFg),
              ],
            ),
          ),
          const SizedBox(height: 10),

          // Urine Sample Card
          MhnCard(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(color: const Color(0xFFFFFBEB), borderRadius: BorderRadius.circular(10)),
                  child: const Icon(Icons.science_outlined, color: Color(0xFFD97706), size: 20),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Urine sample', style: Mhn.t(14, w: FontWeight.w700)),
                      Text('Barcode UR-104718', style: Mhn.t(12, c: Mhn.muted)),
                      Text('Urine Routine Exam', style: Mhn.t(11, c: Mhn.mutedSoft)),
                    ],
                  ),
                ),
                partially
                    ? MhnTag('Not collected', bg: const Color(0xFFFEE2E2), fg: const Color(0xFFDC2626))
                    : MhnTag('Collected', bg: Mhn.tint, fg: Mhn.tintFg),
              ],
            ),
          ),
          const SizedBox(height: 16),

          if (partially)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: const Color(0xFFFFFBEB), borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0xFFFDE68A))),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, size: 20, color: Color(0xFFD97706)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'A urine sample is still needed. Blood was collected. The urine test can’t start until a sample reaches MetroLabs. Contact support to arrange it.',
                      style: Mhn.t(11, c: const Color(0xFF92400E)),
                    ),
                  ),
                ],
              ),
            )
          else
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: const Color(0xFFEFF6FF), borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0xFFBFDBFE))),
              child: Row(
                children: [
                  const Icon(Icons.info_outline, size: 20, color: Color(0xFF2563EB)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Each sample has its own barcode. Progress is updated from lab scans, not from the collector’s GPS. Live location has ended.',
                      style: Mhn.t(11, c: const Color(0xFF1E40AF)),
                    ),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 24),

          Row(
            children: [
              Expanded(
                child: MhnButton(
                  label: 'Back to Home',
                  secondary: true,
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: MhnButton(
                  label: partially ? 'Contact support' : 'Track sample',
                  onPressed: () {
                    if (partially) {
                      mhnToast(context, 'MetroLabs Support: +977-1-4200000');
                    } else {
                      mhnToast(context, 'Sample journey: BL-104717 received at lab');
                    }
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _checkItem(String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            const Icon(Icons.check, size: 16, color: Mhn.green),
            const SizedBox(width: 8),
            Expanded(child: Text(text, style: Mhn.t(13, c: Mhn.ink))),
          ],
        ),
      );
}

class _TrackingMapPainter extends CustomPainter {
  _TrackingMapPainter({
    required this.pulseValue,
    required this.collectorProgress,
    required this.isOffline,
    required this.isReassigned,
  });

  final double pulseValue;
  final double collectorProgress;
  final bool isOffline;
  final bool isReassigned;

  @override
  void paint(Canvas canvas, Size size) {
    final bgPaint = Paint()..color = const Color(0xFFEEF3F0);
    canvas.drawRect(Rect.fromLTWH(0, 0, size.width, size.height), bgPaint);

    final roadPaint = Paint()
      ..color = Colors.white
      ..strokeWidth = 14
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.square;

    // Grid streets
    for (double y = 40; y < size.height; y += 70) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), roadPaint);
    }
    for (double x = 40; x < size.width; x += 80) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), roadPaint);
    }

    // Destination Pin (User home at Baluwatar)
    final dest = Offset(size.width * 0.75, 75);
    final pinPaint = Paint()..color = Mhn.green;
    canvas.drawCircle(dest, 10, pinPaint);
    canvas.drawCircle(dest, 4, Paint()..color = Colors.white);

    // Route path to destination
    if (!isReassigned) {
      final routePaint = Paint()
        ..color = isOffline ? Colors.grey : Mhn.green
        ..strokeWidth = 4
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round;

      final start = Offset(size.width * 0.25, size.height * 0.65);
      final corner = Offset(size.width * 0.75, size.height * 0.65);

      final path = Path()
        ..moveTo(start.dx, start.dy)
        ..lineTo(corner.dx, corner.dy)
        ..lineTo(dest.dx, dest.dy);

      canvas.drawPath(path, routePaint);

      // Collector current position (along the route)
      final collectorPos = Offset(
        start.dx + (corner.dx - start.dx) * 0.6,
        corner.dy,
      );

      // Realtime pulse ring
      if (!isOffline) {
        final pulseRadius = 12 + pulseValue * 14;
        final pulsePaint = Paint()
          ..color = Mhn.green.withValues(alpha: (1 - pulseValue) * 0.4)
          ..style = PaintingStyle.fill;
        canvas.drawCircle(collectorPos, pulseRadius, pulsePaint);
      }

      // Collector icon
      final collPaint = Paint()..color = isOffline ? Colors.grey : const Color(0xFF1B7340);
      canvas.drawCircle(collectorPos, 12, collPaint);
      canvas.drawCircle(collectorPos, 10, Paint()..color = Colors.white);
      final arrowPaint = Paint()..color = isOffline ? Colors.grey : Mhn.green;
      final arrowPath = Path()
        ..moveTo(collectorPos.dx + 4, collectorPos.dy)
        ..lineTo(collectorPos.dx - 4, collectorPos.dy - 4)
        ..lineTo(collectorPos.dx - 2, collectorPos.dy)
        ..lineTo(collectorPos.dx - 4, collectorPos.dy + 4)
        ..close();
      canvas.drawPath(arrowPath, arrowPaint);
    }
  }

  @override
  bool shouldRepaint(_TrackingMapPainter old) =>
      old.pulseValue != pulseValue || old.isOffline != isOffline || old.isReassigned != isReassigned;
}
