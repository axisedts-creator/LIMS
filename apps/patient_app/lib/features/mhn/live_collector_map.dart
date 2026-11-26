// PHLEBO-UI-FULL-1: where the phlebotomist is right now, for the booking screen. Lives with the other map code of this
// app (the bookings feature itself stays free of map packages and coordinates). View only; the map recentres when the
// position changes. Tiles: the same OpenStreetMap source as the address picker.
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart' as ll;
import 'package:lims_ui/lims_ui.dart';

/// The live position inside a booking's `tracking` block, or null when there is none or it is malformed.
class LivePosition {
  const LivePosition(this.latitude, this.longitude, this.capturedAt);

  final double latitude, longitude;
  final DateTime? capturedAt;

  static LivePosition? of(Map<String, Object?>? tracking) {
    final c = tracking?['coordinates'];
    if (c is! Map) return null;
    final lat = c['latitude'], lng = c['longitude'];
    if (lat is! num || lng is! num || lat.abs() > 90 || lng.abs() > 180) return null;
    return LivePosition(lat.toDouble(), lng.toDouble(), DateTime.tryParse('${c['captured_at']}'));
  }

  /// "just now" / "4 min ago" / "recently" (no time known).
  String age(DateTime now) {
    final at = capturedAt;
    if (at == null) return 'recently';
    final d = now.difference(at);
    return d.inSeconds < 60 ? 'just now' : '${d.inMinutes} min ago';
  }
}

class LiveCollectorMap extends StatefulWidget {
  const LiveCollectorMap({super.key, required this.position});

  final LivePosition position;

  @override
  State<LiveCollectorMap> createState() => _LiveCollectorMapState();
}

class _LiveCollectorMapState extends State<LiveCollectorMap> {
  final _map = MapController();

  ll.LatLng get _at => ll.LatLng(widget.position.latitude, widget.position.longitude);

  @override
  void didUpdateWidget(LiveCollectorMap old) {
    super.didUpdateWidget(old);
    if (old.position.latitude != widget.position.latitude || old.position.longitude != widget.position.longitude) {
      _map.move(_at, _map.camera.zoom);
    }
  }

  @override
  void dispose() {
    _map.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Map showing where the phlebotomist is',
        child: ClipRRect(
          borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusLg)),
          child: SizedBox(
            height: 220,
            child: FlutterMap(
              mapController: _map,
              options: MapOptions(initialCenter: _at, initialZoom: 15, interactionOptions: const InteractionOptions(flags: InteractiveFlag.none)),
              children: [
                TileLayer(urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', userAgentPackageName: 'invalid.lims.patient_app.dev', maxZoom: 19),
                MarkerLayer(markers: [
                  Marker(point: _at, width: 48, height: 48, child: const Icon(Icons.directions_bike, size: 36, color: LimsTokens.colorAccentDefault)),
                ]),
              ],
            ),
          ),
        ),
      );
}
