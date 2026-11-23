// Book collection, step 1 of 2: patient, collection method (home / centre), address, date, available time slots.
// Connected to LIMS APIs: E13 profiles, E31 centres, E37 addresses, E32 available slots.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../bookings/bookings_format.dart';
import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import 'member_form_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'pay_screen.dart';

class MhnBookScreen extends ConsumerStatefulWidget {
  const MhnBookScreen({super.key});

  @override
  ConsumerState<MhnBookScreen> createState() => _MhnBookScreenState();
}

class _MhnBookScreenState extends ConsumerState<MhnBookScreen> {
  late final TextEditingController _address;
  String _err = '';

  // Server-loaded data
  List<Map<String, Object?>> _addresses = [];
  List<Map<String, Object?>> _centres = [];
  List<LimsSlotDay> _slotDays = [];
  bool _loadingSlots = false;
  int _selectedSlotDayIndex = 0;
  String? _selectedSlotStart;
  String? _selectedSlotLabel;
  String? _selectedCentreId;
  String? _selectedAddressId;
  int _slotToken = 0;
  bool _apiAvailable = false;

  @override
  void initState() {
    super.initState();
    final st = ref.read(mhnProvider);
    _address = TextEditingController(text: st.address);
    _selectedCentreId = st.selectedCentreId;
    _selectedAddressId = st.selectedAddressId;
    _loadInitialData();
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _loadInitialData() async {
    try {
      ref.invalidate(bookingProfilesProvider);
      final api = ref.read(patientBookingsApiProvider);
      final profileId = ref.read(mhnProvider).selectedProfileId;

      // 1. Load addresses
      final addrRes = asMap(await api.listAddresses(profileId: profileId));
      if (mounted) {
        setState(() {
          _addresses = mapList(addrRes?['data']);
          if (_addresses.isNotEmpty && _selectedAddressId == null) {
            _selectedAddressId = _addresses.first['id'] as String?;
            if (_address.text.isEmpty && _addresses.first['address_text'] is String) {
              _address.text = _addresses.first['address_text']! as String;
              ref.read(mhnProvider.notifier).setAddress(_address.text);
            }
          }
        });
      }

      // 2. Load centres
      final centreRes = asMap(await api.listBookingCentres(bookingKind: 'centre_visit'));
      if (mounted) {
        setState(() {
          _centres = mapList(centreRes?['data']);
          final preferredCentreId = _selectedCentreId ?? ref.read(mhnProvider).selectedCentreId;
          final match = _centres.firstWhere(
            (c) => c['centre_id'] == preferredCentreId,
            orElse: () => _centres.isNotEmpty ? _centres.first : const <String, Object?>{},
          );
          if (match.isNotEmpty) {
            _selectedCentreId = match['centre_id'] as String?;
            ref.read(mhnProvider.notifier).setSelectedCentreId(_selectedCentreId);
          }
        });
      }

      // 3. Load slots
      await _loadSlots();
      if (mounted) setState(() => _apiAvailable = true);
    } catch (_) {
      // Offline fallback: slots loaded from prototype
    }
  }

  Future<void> _loadSlots() async {
    final token = ++_slotToken;
    final mode = ref.read(mhnProvider.notifier).effectiveMode;
    final bookingKind = mode == 'home' ? 'home_collection' : 'centre_visit';
    final centreId = mode == 'home' ? null : _selectedCentreId;

    setState(() => _loadingSlots = true);

    try {
      final api = ref.read(patientBookingsApiProvider);
      final now = DateTime.now();
      final from = localYmd(now);
      final to = localYmd(now.add(const Duration(days: 7)));

      final res = asMap(await api.listSlots(
        bookingKind: bookingKind,
        centreId: centreId,
        dateFrom: from,
        dateTo: to,
      ));

      if (!mounted || token != _slotToken) return;

      final data = mapList(res?['data']);
      final days = slotDays(data);

      setState(() {
        _slotDays = days;
        _loadingSlots = false;
        if (_slotDays.isNotEmpty && _selectedSlotDayIndex >= _slotDays.length) {
          _selectedSlotDayIndex = 0;
        }
      });
    } catch (_) {
      if (mounted && token == _slotToken) {
        setState(() => _loadingSlots = false);
      }
    }
  }

  void _next() {
    final st = ref.read(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final mode = ctl.effectiveMode;

    final hasSlot = st.slot >= 0 || _selectedSlotStart != null;
    if (!hasSlot) return setState(() => _err = 'Choose a time slot.');

    if (mode == 'home' && st.address.trim().length < 6) {
      return setState(() => _err = 'Enter the full collection address.');
    }

    setState(() => _err = '');
    ctl.setSelectedSlot(slotStart: _selectedSlotStart, slotLabel: _selectedSlotLabel);
    ctl.setSelectedCentreId(_selectedCentreId);
    ctl.setSelectedAddressId(_selectedAddressId);
    if (!st.isMockPrototype && st.selectedProfileId == null) {
      final profiles = ref.read(bookingProfilesProvider).asData?.value;
      if (profiles != null && profiles.isNotEmpty) {
        ctl.setSelectedProfileId(profiles.first.id);
      } else {
        return setState(() => _err = 'No authorized patient profile found. Please link or register your profile.');
      }
    }

    mhnPush<void>(context, const MhnPayScreen());
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final mode = ctl.effectiveMode;
    final forceLab = ctl.hasImaging;
    final days = MhnController.days();
    final firstName = st.profile.name.split(' ').first;
    final addrErr = _err.contains('address');

    // Async server profiles
    final serverProfilesAsync = ref.watch(bookingProfilesProvider);

    return MhnPage(
      title: 'Book collection',
      bottom: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_err.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(_err, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.danger)),
          ),
        MhnButton(label: 'Review & pay', onPressed: _next),
      ]),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        children: [
          Row(children: [
            Text('1 Who & when', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.green)),
            Text('  ›  ', style: Mhn.t(12, c: Mhn.mutedSoft)),
            Text('2 Review & pay', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          ]),
          const SizedBox(height: 16),
          Text('Who is this for?', style: Mhn.h2),
          const SizedBox(height: 10),

          // Profiles section
          serverProfilesAsync.when(
            data: (profiles) {
              if (profiles.isNotEmpty) {
                return Wrap(spacing: 8, runSpacing: 8, children: [
                  for (var i = 0; i < profiles.length; i++)
                    MhnChip(
                      label: i == 0 ? '${profiles[i].displayName} (you)' : profiles[i].displayName,
                      selected: st.selectedProfileId == profiles[i].id || (st.selectedProfileId == null && i == 0),
                      radius: 14,
                      onTap: () {
                        ctl.setSelectedProfileId(profiles[i].id);
                        ctl.setWho(profiles[i].id);
                      },
                    ),
                  Material(
                    color: Mhn.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: Mhn.green)),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => mhnPush<void>(context, const MhnMemberFormScreen()),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        child: Text('+ Add member', style: Mhn.t(14, w: FontWeight.w600, c: Mhn.green)),
                      ),
                    ),
                  ),
                ]);
              }
              return _buildFallbackProfiles(st, ctl, firstName);
            },
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: LinearProgressIndicator(color: Mhn.green),
            ),
            error: (_, _) => _buildFallbackProfiles(st, ctl, firstName),
          ),

          const SizedBox(height: 20),
          Text('Where?', style: Mhn.h2),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: Opacity(
                opacity: forceLab ? .45 : 1,
                child: MhnChip(
                  label: 'Home collection',
                  selected: mode == 'home',
                  radius: 14,
                  onTap: () {
                    if (forceLab) {
                      mhnToast(context, 'Imaging needs a centre visit');
                    } else {
                      ctl.setMode('home');
                      _loadSlots();
                    }
                  },
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: MhnChip(
                label: 'Centre visit',
                selected: mode == 'lab',
                radius: 14,
                onTap: () {
                  ctl.setMode('lab');
                  _loadSlots();
                },
              ),
            ),
          ]),

          if (mode == 'home') ...[
            const SizedBox(height: 14),
            if (_addresses.isNotEmpty) ...[
              Text('Saved addresses', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final addr in _addresses)
                  MhnChip(
                    label: '${addr['label'] ?? 'Address'}: ${(addr['address_text'] as String?)?.split(',').first ?? ''}',
                    selected: _selectedAddressId == addr['id'],
                    radius: 12,
                    onTap: () {
                      setState(() {
                        _selectedAddressId = addr['id'] as String?;
                        _address.text = (addr['address_text'] as String?) ?? '';
                      });
                      ctl.setAddress(_address.text);
                      ctl.setSelectedAddressId(_selectedAddressId);
                    },
                  ),
              ]),
              const SizedBox(height: 10),
            ],
            MhnField(
              label: 'Collection address',
              controller: _address,
              hint: 'House, street, area, city',
              error: addrErr ? _err : null,
              onChanged: (v) {
                ctl.setAddress(v);
                if (_err.isNotEmpty) setState(() => _err = '');
              },
            ),
          ] else ...[
            const SizedBox(height: 14),
            if (_centres.isNotEmpty) ...[
              for (final c in _centres)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Mhn.rCard),
                    onTap: () {
                      if (_selectedCentreId == c['centre_id']) return;
                      setState(() {
                        _selectedCentreId = c['centre_id'] as String?;
                        _selectedSlotStart = null;
                        _selectedSlotLabel = null;
                        _err = '';
                      });
                      ctl.setSelectedCentreId(_selectedCentreId);
                      ctl.setSelectedSlot(slotStart: null, slotLabel: null);
                      _loadSlots();
                    },
                    child: Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Mhn.white,
                        borderRadius: BorderRadius.circular(Mhn.rCard),
                        border: Border.all(
                          color: _selectedCentreId == c['centre_id'] ? Mhn.green : Mhn.line,
                          width: _selectedCentreId == c['centre_id'] ? 2 : 1,
                        ),
                      ),
                      child: Row(children: [
                        Icon(
                          _selectedCentreId == c['centre_id'] ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                          color: _selectedCentreId == c['centre_id'] ? Mhn.green : Mhn.muted,
                          size: 20,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text((c['display_name'] as String?) ?? 'Metro Labs Centre', style: Mhn.t(15, w: FontWeight.w700)),
                            if (c['address_text'] is String)
                              Text(c['address_text']! as String, style: Mhn.t(12, c: Mhn.muted)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                ),
            ] else ...[
              MhnCard(
                padding: const EdgeInsets.all(14),
                child: Row(children: [
                  const MhnIconTile(Icons.location_on_outlined),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Metro Labs, Baneshwor', style: Mhn.t(15, w: FontWeight.w700)),
                      Text('Show your booking ID at reception.', style: Mhn.t(12, c: Mhn.muted)),
                    ]),
                  ),
                ]),
              ),
            ],
          ],

          const SizedBox(height: 20),
          Text('Date', style: Mhn.h2),
          const SizedBox(height: 10),

          // Date selector
          if (_slotDays.isNotEmpty) ...[
            SizedBox(
              height: 86,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _slotDays.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final dayStr = _slotDays[i].date;
                  final parsed = DateTime.tryParse(dayStr) ?? DateTime.now();
                  final isToday = localYmd(DateTime.now()) == dayStr;
                  return SizedBox(
                    width: 72,
                    child: MhnChip(
                      label: isToday ? 'Today' : weekdayShort(parsed),
                      sub: '${parsed.day}\n${monthShort(parsed)}',
                      selected: _selectedSlotDayIndex == i,
                      radius: 14,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      onTap: () {
                        setState(() {
                          _selectedSlotDayIndex = i;
                          _err = '';
                        });
                      },
                    ),
                  );
                },
              ),
            ),
          ] else if (_apiAvailable) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text('No dates or slots available for this location.', style: Mhn.t(13, c: Mhn.muted)),
            ),
          ] else ...[
            SizedBox(
              height: 86,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: days.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (_, i) => SizedBox(
                  width: 72,
                  child: MhnChip(
                    label: i == 0 ? 'Tmrw' : weekdayShort(days[i]),
                    sub: '${days[i].day}\n${monthShort(days[i])}',
                    selected: st.day == i,
                    radius: 14,
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    onTap: () {
                      ctl.setDay(i);
                      setState(() => _err = '');
                    },
                  ),
                ),
              ),
            ),
          ],

          const SizedBox(height: 20),
          Text('Time slot', style: Mhn.h2),
          const SizedBox(height: 10),

          // Time slot selector
          if (_loadingSlots)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(child: CircularProgressIndicator(color: Mhn.green)),
            )
          else if (_slotDays.isNotEmpty && _selectedSlotDayIndex < _slotDays.length) ...[
            LayoutBuilder(builder: (context, c) {
              final w = (c.maxWidth - 10) / 2;
              final currentDaySlots = _slotDays[_selectedSlotDayIndex].slots;
              if (currentDaySlots.isEmpty) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Center(child: Text('No slots available for this day.', style: Mhn.t(13, c: Mhn.muted))),
                );
              }
              return Wrap(spacing: 10, runSpacing: 10, children: [
                for (var i = 0; i < currentDaySlots.length; i++)
                  SizedBox(
                    width: w,
                    child: MhnChip(
                      label: currentDaySlots[i].label,
                      sub: '${currentDaySlots[i].remaining} left',
                      selected: _selectedSlotStart == currentDaySlots[i].start,
                      radius: 14,
                      onTap: () {
                        setState(() {
                          _selectedSlotStart = currentDaySlots[i].start;
                          _selectedSlotLabel = currentDaySlots[i].label;
                          _err = '';
                        });
                        ctl.setSelectedSlot(slotStart: _selectedSlotStart, slotLabel: _selectedSlotLabel);
                        ctl.setSlot(i);
                      },
                    ),
                  ),
              ]);
            }),
          ] else if (_apiAvailable) ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text('No slots available for this location.', style: Mhn.t(13, c: Mhn.muted)),
            ),
          ] else ...[
            // Prototype / demo slots
            LayoutBuilder(builder: (context, c) {
              final w = (c.maxWidth - 10) / 2;
              return Wrap(spacing: 10, runSpacing: 10, children: [
                for (var i = 0; i < kSlots.length; i++)
                  SizedBox(
                    width: w,
                    child: MhnChip(
                      label: kSlots[i],
                      selected: st.slot == i,
                      radius: 14,
                      onTap: () {
                        ctl.setSlot(i);
                        setState(() => _err = '');
                      },
                    ),
                  ),
              ]);
            }),
          ],
        ],
      ),
    );
  }

  Widget _buildFallbackProfiles(MhnState st, MhnController ctl, String firstName) {
    return Wrap(spacing: 8, runSpacing: 8, children: [
      MhnChip(label: '$firstName (you)', selected: st.who == 'self', radius: 14, onTap: () => ctl.setWho('self')),
      for (final m in st.members)
        MhnChip(label: '${m.name.split(' ').first} · ${m.relation}', selected: st.who == m.id, radius: 14, onTap: () => ctl.setWho(m.id)),
      Material(
        color: Mhn.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: Mhn.green)),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => mhnPush<void>(context, const MhnMemberFormScreen()),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text('+ Add member', style: Mhn.t(14, w: FontWeight.w600, c: Mhn.green)),
          ),
        ),
      ),
    ]);
  }
}
