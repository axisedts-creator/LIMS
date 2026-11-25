// Badge words shared by the Today and Visit screens.

/// Visit kind badge text (C17 04-UI-UX §2.1 kinds). Plain bookings get no badge.
String? kindLabel(String kind) => switch (kind) {
      'recollection' => 'Recollection',
      'revisit' => 'Revisit',
      'front_desk' => 'Phone request',
      _ => null,
    };

/// Open-flag badge text (04-UI-UX §2.1 flag labels, the ones that matter on the phone).
String? flagLabel(String flag) => switch (flag) {
      'address_missing' => 'Address needed',
      'recollection_required' => 'Recollection',
      'specimens_stale' => 'Refresh tubes',
      _ => null,
    };

/// Tone of a kind/flag badge: a new sample or a missing address needs attention (warning), a revisit informs, a phone request is plain.
String kindTone(String kind, String label) {
  if (label == kindLabel('front_desk')) return 'neutral';
  if (label == kindLabel('revisit')) return 'info';
  return 'warning';
}
