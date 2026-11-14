// A17 Booking wizard (04-UI-UX A17 steps 1-6; 03-APP-FLOW §6.1 wizard rules, §6.2 reschedule; US-EN-12.1-8, 13.1-2, 14.3). Who -> Type -> Tests (E30) -> Place (E31 / E37) -> Date & time (E32) -> Review (E33).
// Entries live in widget state only (Back keeps them; leaving the wizard drops them). One primary LimsButton per page ("Continue" / "Confirm booking"), a secondary "Back" from step 2 on (LD-140).
// Idempotency-Key per review step: a NEW random key every time the review step is entered, reused for a retry of the same confirm (timeout / network); the button is disabled while a request is in flight.
// The body carries the profile (link) id, never a patient id (AB-7). Reschedule = the same E33 with replaces_booking_id + replaces_booking_version, opened at the slot step with the old booking's kind / centre / tests.
// [CONV] LD-140: lims_ui components and token names only; REQ-SEC-109: LimsSecureScreen. Sex restriction: the profile's sex hides the other sex's items; an unknown sex shows all with "Suitability is confirmed at the lab".
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'addresses_screen.dart';
import 'bookings_api.dart';
import 'bookings_format.dart';
import 'bookings_providers.dart';

typedef _Map = Map<String, Object?>;

class BookingWizardScreen extends ConsumerStatefulWidget {
  const BookingWizardScreen({super.key, this.rescheduleOf});

  /// The decoded Booking being replaced (A18 [Reschedule]); the wizard then opens at the slot step.
  final Map<String, Object?>? rescheduleOf;

  @override
  ConsumerState<BookingWizardScreen> createState() =>
      _BookingWizardScreenState();
}

class _BookingWizardScreenState extends ConsumerState<BookingWizardScreen> {
  static const _who = 0,
      _type = 1,
      _tests = 2,
      _place = 3,
      _slotStep = 4,
      _review = 5;

  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  late final BookingConfig _config = ref.read(bookingConfigProvider);
  int _step = _who;
  String? _notice;

  // entries (in memory only)
  String? _profileId,
      _profileName,
      _sex,
      _kind,
      _centreId,
      _addressId,
      _placeLabel,
      _slot,
      _key;
  final Map<String, _Map> _selected =
      {}; // orderable_id -> BookableItem, in selection order

  // fetched lists
  List<_Map>? _items;
  String? _itemsCursor;
  String _query = '';
  Timer? _debounce;
  int _itemsToken = 0;
  bool _itemsLoading = false, _itemsFailed = false;
  List<_Map>? _centres, _addresses;
  bool _placeLoading = false, _placeFailed = false;
  List<_Map>? _slots;
  int _windowOffset = 0;
  bool _slotsLoading = false, _slotsFailed = false;

  bool _submitting = false;
  _Map? _done;

  bool get _reschedule => widget.rescheduleOf != null;
  bool get _home => _kind == 'home_collection';

  @override
  void initState() {
    super.initState();
    final old = widget.rescheduleOf;
    if (old != null) {
      _profileId = old['profile_id'] as String?;
      _kind = old['booking_kind'] as String?;
      _centreId = _kind == 'centre_visit' ? old['centre_id'] as String? : null;
      _addressId = old['home_address_id'] as String?;
      _placeLabel = placeText(old);
      for (final i in mapList(old['items'])) {
        if (i['orderable_id'] is String)
          _selected[i['orderable_id']! as String] = i;
      }
      _step = _slotStep;
      Future.microtask(() => _enter(_slotStep));
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  // ---- navigation ---------------------------------------------------------------------------------------------------------------------------------------------

  void _goto(int s, {String? notice}) {
    setState(() {
      _step = s;
      _notice = notice;
    });
    _enter(s);
  }

  void _enter(int s) {
    if (!mounted) return;
    if (s == _tests && _items == null) _loadItems();
    if (s == _place) _loadPlace();
    if (s == _slotStep && _slots == null) _loadSlots();
    if (s == _review)
      _key = newIdempotencyKey(); // Idempotency-Key per review step
  }

  bool get _canContinue => switch (_step) {
    _who => _profileId != null,
    _type => _kind != null,
    _tests => _selected.isNotEmpty,
    _place => _home ? _addressId != null : _centreId != null,
    _slotStep => _slot != null,
    _ => !_submitting,
  };

  void _next() {
    if (_step == _review) {
      _submit();
    } else if (_canContinue) {
      _goto(_step + 1);
    }
  }

  // ---- step 1 / 2 ---------------------------------------------------------------------------------------------------------------------------------------------

  void _pickProfile(BookingProfile p) {
    if (p.id == _profileId) return;
    setState(() {
      _profileId = p.id;
      _profileName = p.displayName;
      _sex = p.sex;
      _selected.removeWhere(
        (_, i) => _hidden(i),
      ); // a different sex may exclude chosen items
      _addresses = null; // addresses belong to the profile
      if (_home) _addressId = null;
    });
  }

  void _pickKind(String kind) {
    if (kind == _kind) return;
    setState(() {
      _kind = kind;
      _items = null; // E30 is asked per kind
      _itemsCursor = null;
      _selected.clear();
      _centreId = _addressId = _placeLabel = _slot = null;
      _slots = null;
    });
  }

  // ---- step 3: tests ------------------------------------------------------------------------------------------------------------------------------------------

  bool _hidden(_Map i) =>
      (_sex == 'male' || _sex == 'female') &&
      i['sex_restriction'] is String &&
      i['sex_restriction'] != _sex;
  bool _unsure(_Map i) =>
      i['sex_restriction'] is String && _sex != 'male' && _sex != 'female';

  Future<void> _loadItems({bool more = false}) async {
    final kind = _kind;
    if (kind == null) return;
    final token = ++_itemsToken; // a newer search supersedes this answer
    setState(() {
      _itemsLoading = true;
      _itemsFailed = false;
    });
    try {
      final body = asMap(
        await _api.listBookableItems(
          bookingKind: kind,
          query: _query.isEmpty ? null : _query,
          cursor: more ? _itemsCursor : null,
        ),
      );
      if (!mounted || token != _itemsToken) return;
      final next = asMap(body?['page'])?['next_cursor'];
      setState(() {
        _items = more
            ? [...?_items, ...mapList(body?['data'])]
            : mapList(body?['data']);
        _itemsCursor = next is String ? next : null;
        _itemsLoading = false;
      });
    } on Object {
      if (mounted && token == _itemsToken) {
        setState(() {
          _itemsLoading = false;
          _itemsFailed = true; // never show server detail
        });
      }
    }
  }

  void _search(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (v.trim() != _query) {
        _query = v.trim();
        _loadItems();
      }
    });
  }

  void _toggle(_Map item) {
    final id = item['orderable_id'];
    if (id is! String) return;
    setState(() {
      _notice = null;
      if (_selected.remove(id) != null) return;
      if (_selected.length >= _config.maxOrderablesPerBooking) {
        _notice =
            'You can choose up to ${_config.maxOrderablesPerBooking} tests in one booking.';
        return;
      }
      _selected[id] = item;
    });
  }

  // ---- step 4: place ------------------------------------------------------------------------------------------------------------------------------------------

  Future<void> _loadPlace() async {
    if (_home ? _addresses != null : _centres != null) return;
    setState(() {
      _placeLoading = true;
      _placeFailed = false;
    });
    try {
      if (_home) {
        final r = mapList(
          asMap(await _api.listAddresses(profileId: _profileId))?['data'],
        );
        if (mounted) setState(() => _addresses = r);
      } else {
        final r = mapList(
          asMap(
            await _api.listBookingCentres(bookingKind: 'centre_visit'),
          )?['data'],
        );
        if (mounted) setState(() => _centres = r);
      }
      if (mounted) setState(() => _placeLoading = false);
    } on Object {
      if (mounted) {
        setState(() {
          _placeLoading = false;
          _placeFailed = true;
        });
      }
    }
  }

  void _pickCentre(_Map c) => setState(() {
    if (_centreId != c['centre_id'])
      _slots = null; // slots belong to the centre
    _centreId = c['centre_id'] as String?;
    _placeLabel = c['display_name'] as String?;
    _slot = null;
  });

  void _pickAddress(_Map a) => setState(() {
    _addressId = a['id'] as String?;
    _placeLabel = a['address_text'] as String?;
  });

  Future<void> _addAddress() async {
    final r = await Navigator.of(context).push<Object?>(
      MaterialPageRoute<Object?>(
        builder: (_) => AddressFormScreen(profileId: _profileId),
      ),
    );
    if (r is Map<String, Object?> && mounted) {
      setState(() => _addresses = [...?_addresses, r]);
      _pickAddress(r);
    }
  }

  // ---- step 5: slots ------------------------------------------------------------------------------------------------------------------------------------------

  Future<void> _loadSlots() async {
    final kind = _kind;
    if (kind == null) return;
    final today = kathmandu(DateTime.now().toUtc().toIso8601String())!;
    final from = today.add(Duration(days: _windowOffset)),
        to = from.add(const Duration(days: 6)); // E32 for 7 days at a time
    setState(() {
      _slotsLoading = true;
      _slotsFailed = false;
      _slot = null;
    });
    try {
      final body = asMap(
        await _api.listSlots(
          bookingKind: kind,
          centreId: _home ? null : _centreId,
          dateFrom: localYmd(from),
          dateTo: localYmd(to),
        ),
      );
      if (mounted) {
        setState(() {
          _slots = mapList(body?['data']);
          _slotsLoading = false;
        });
      }
    } on Object {
      if (mounted) {
        setState(() {
          _slotsLoading = false;
          _slotsFailed = true;
        });
      }
    }
  }

  void _moveWindow(int days) {
    _windowOffset = (_windowOffset + days).clamp(0, 70);
    _loadSlots();
  }

  // ---- step 6: submit -----------------------------------------------------------------------------------------------------------------------------------------

  _Map _requestBody() => {
    'profile_id': _profileId,
    'booking_kind': _kind,
    if (!_home) 'centre_id': _centreId,
    'slot_start': _slot,
    'orderable_ids': [..._selected.keys],
    if (_home) 'home_address_id': _addressId,
    if (_reschedule) 'replaces_booking_id': widget.rescheduleOf!['id'],
    if (_reschedule)
      'replaces_booking_version': widget.rescheduleOf!['version'],
  };

  Future<void> _submit() async {
    if (_submitting || _slot == null || _profileId == null || _kind == null)
      return;
    setState(() {
      _submitting = true;
      _notice = null;
    });
    try {
      final created = asMap(
        await _api.createBooking(body: _requestBody(), idempotencyKey: _key!),
      );
      if (!mounted) return;
      if (created == null) throw StateError('empty answer');
      setState(() => _done = created);
    } on Object catch (e) {
      if (!mounted) return;
      final taken =
          e is LimsException &&
          (e.code == LimsErrorCodes.engagementSlotUnavailable ||
              e.code == LimsErrorCodes.engagementSlotOutsideWindow);
      if (taken) {
        _slots = null; // fresh slots, nothing selected
        _slot = null;
        _goto(_slotStep, notice: bookingErrorText(e));
      } else {
        setState(
          () => _notice = bookingErrorText(e),
        ); // the review step stays open for a retry (same key)
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ---- build --------------------------------------------------------------------------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final done = _done;
    final backFrom = _reschedule ? _slotStep : _who;
    return LimsSecureScreen(
      child: Scaffold(
        appBar: AppBar(title: Text(_reschedule ? 'Reschedule' : 'Book a test')),
        body: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(LimsTokens.space4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_notice != null) ...[
                      BookingBanner(text: _notice!),
                      const SizedBox(height: LimsTokens.space3),
                    ],
                    if (done != null)
                      ..._confirmation(done)
                    else
                      ..._stepBody(context),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(LimsTokens.space4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: done != null
                        ? LimsButton(
                            label: 'Done',
                            onPressed: () =>
                                Navigator.of(context)
                                    .popUntil((r) => r.isFirst),
                          )
                        : LimsButton(
                            label: _step == _review
                                ? 'Confirm booking'
                                : 'Continue',
                            onPressed: _canContinue ? _next : null,
                          ),
                  ),
                  if (done == null && _step > backFrom) ...[
                    const SizedBox(height: LimsTokens.space2),
                    SizedBox(
                      width: double.infinity,
                      child: LimsButton(
                        label: 'Back',
                        secondary: true,
                        onPressed: _submitting ? null : () => _goto(_step - 1),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _title(String text) => Padding(
    padding: const EdgeInsets.only(bottom: LimsTokens.space2),
    child: Text(text, style: Theme.of(context).textTheme.titleMedium),
  );

  List<Widget> _stepBody(BuildContext context) => switch (_step) {
    _who => _whoBody(),
    _type => _typeBody(),
    _tests => _testsBody(),
    _place => _placeBody(),
    _slotStep => _slotBody(),
    _ => _reviewBody(),
  };

  List<Widget> _whoBody() => [
    _title('Who is it for?'),
    ...ref
        .watch(bookingProfilesProvider)
        .when(
          data: (ps) => [
            for (final p in ps)
              ChoiceRow(
                title: p.displayName,
                selected: p.id == _profileId,
                onTap: () => _pickProfile(p),
              ),
          ],
          loading: () => const [LimsLoading()],
          error: (_, _) => [
            LimsErrorState(
              title: 'Something went wrong',
              message: 'We could not load the people on your account.',
              onRetry: () => ref.invalidate(bookingProfilesProvider),
            ),
          ],
        ),
  ];

  List<Widget> _typeBody() => [
    _title('How will the sample be taken?'),
    ChoiceRow(
      title: 'Visit a centre',
      selected: _kind == 'centre_visit',
      onTap: () => _pickKind('centre_visit'),
    ),
    if (_config.homeCollection)
      ChoiceRow(
        title: 'Home collection',
        selected: _kind == 'home_collection',
        onTap: () => _pickKind('home_collection'),
      ),
  ];

  List<Widget> _testsBody() {
    final shown = [
      for (final i in _items ?? const <_Map>[])
        if (!_hidden(i)) i,
    ];
    return [
      _title('Choose tests'),
      LimsTextField(label: 'Search tests', maxLength: 40, onChanged: _search),
      if (_selected.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: LimsTokens.space2),
          child: Text('${_selected.length} selected'),
        ),
      if (_itemsFailed)
        LimsErrorState(
          title: 'Something went wrong',
          message: 'We could not load the tests.',
          onRetry: _loadItems,
        )
      else if (_items == null || (_itemsLoading && shown.isEmpty))
        const LimsLoading()
      else if (shown.isEmpty)
        const LimsEmptyState(title: 'No tests found')
      else
        for (final i in shown)
          CheckboxListTile(
            controlAffinity: ListTileControlAffinity.leading,
            value: _selected.containsKey(i['orderable_id']),
            onChanged: (_) => _toggle(i),
            title: Text('${i['display_name']}'),
            subtitle: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(priceText(i)),
                if (_unsure(i))
                  const Text('Suitability is confirmed at the lab'),
              ],
            ),
          ),
      if (_itemsCursor != null && !_itemsLoading)
        LimsButton(
          label: 'Show more tests',
          secondary: true,
          onPressed: () => _loadItems(more: true),
        ),
    ];
  }

  List<Widget> _placeBody() {
    if (_placeFailed)
      return [
        LimsErrorState(
          title: 'Something went wrong',
          message: _home
              ? 'We could not load your addresses.'
              : 'We could not load the centres.',
          onRetry: _loadPlace,
        ),
      ];
    if (_placeLoading || (_home ? _addresses : _centres) == null)
      return const [LimsLoading()];
    if (_home) {
      return [
        _title('Choose an address'),
        for (final a in _addresses!)
          ChoiceRow(
            title: '${a['address_text']}',
            subtitle: addressLabels[a['label']],
            selected: a['id'] == _addressId,
            onTap: () => _pickAddress(a),
          ),
        const SizedBox(height: LimsTokens.space2),
        LimsButton(
          label: 'Add address',
          secondary: true,
          onPressed: _addAddress,
        ),
      ];
    }
    return [
      _title('Choose a centre'),
      if (_centres!.isEmpty)
        const LimsEmptyState(title: 'No centres available'),
      for (final c in _centres!)
        ChoiceRow(
          title: '${c['display_name']}',
          subtitle: c['address_text'] as String?,
          selected: c['centre_id'] == _centreId,
          onTap: () => _pickCentre(c),
        ),
    ];
  }

  List<Widget> _slotBody() {
    if (_slotsFailed)
      return [
        LimsErrorState(
          title: 'Something went wrong',
          message: 'We could not load the available times.',
          onRetry: _loadSlots,
        ),
      ];
    if (_slotsLoading || _slots == null) return const [LimsLoading()];
    return [
      _title('Pick a date and time'),
      LimsSlotPicker(
        days: slotDays(_slots!),
        selected: _slot,
        calendarMode: _config.calendarMode,
        onSelected: (s) => setState(() => _slot = s),
      ),
      const SizedBox(height: LimsTokens.space3),
      LimsButton(
        label: 'Show next 7 days',
        secondary: true,
        onPressed: () => _moveWindow(7),
      ),
      if (_windowOffset > 0) ...[
        const SizedBox(height: LimsTokens.space2),
        LimsButton(
          label: 'Show earlier days',
          secondary: true,
          onPressed: () => _moveWindow(-7),
        ),
      ],
    ];
  }

  List<Widget> _reviewBody() {
    final t = Theme.of(context).textTheme;
    final name =
        _profileName ??
        ref
            .read(bookingProfilesProvider)
            .value
            ?.where((p) => p.id == _profileId)
            .map((p) => p.displayName)
            .firstOrNull ??
        '';
    final items = _selected.values.toList();
    final total = indicativeTotal(items);
    Widget line(String label, String value) => Padding(
      padding: const EdgeInsets.only(bottom: LimsTokens.space2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: t.bodySmall),
          Text(value, style: t.bodyLarge),
        ],
      ),
    );
    return [
      _title('Review and confirm'),
      if (name.isNotEmpty) line('For', name),
      line(
        _home ? 'Collection' : 'Centre',
        _home ? 'Home collection' : (_placeLabel ?? ''),
      ),
      if (_home && _placeLabel != null) line('Address', _placeLabel!),
      line('Date and time', dateTimeText(_slot)),
      Text('Tests', style: t.bodySmall),
      for (final i in items)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
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
          child: Text(
            'Indicative total: ${rupees(total)}',
            style: t.titleSmall,
          ),
        ),
      const Padding(
        padding: EdgeInsets.only(top: LimsTokens.space1),
        child: Text('Final price is confirmed at the lab.'),
      ),
    ];
  }

  List<Widget> _confirmation(_Map b) {
    final t = Theme.of(context).textTheme;
    final tone = limsTone('success');
    return [
      Row(
        children: [
          Icon(Icons.check_circle, color: tone.fg),
          const SizedBox(width: LimsTokens.space2),
          Text('Booking confirmed', style: t.titleMedium),
        ],
      ),
      const SizedBox(height: LimsTokens.space3),
      Text('Booking no. ${b['booking_no']}', style: t.titleSmall),
      Text(dateTimeText(b['slot_start'])),
      Text(placeText(b)),
      if (_home && _placeLabel != null) Text(_placeLabel!),
    ];
  }
}
