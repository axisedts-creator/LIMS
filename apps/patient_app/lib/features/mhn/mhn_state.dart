// My Health Now UI state (SAMPLE data, in memory only). Cart, booking draft, bookings, membership, profile and family members.
// Nothing here is persisted or sent anywhere: persistence and the API come with the feature wiring that follows the UI.
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../orders/orders_format.dart';
import 'mhn_data.dart';

@immutable
class MhnProfile {
  const MhnProfile({required this.name, required this.phone, this.email = '', this.dob = '', this.gender = 'Male', this.blood = '', this.height = 170, this.weight = 65});
  final String name;
  final String phone;
  final String email;
  final String dob; // yyyy-MM-dd or ''
  final String gender;
  final String blood;
  final int height;
  final int weight;

  MhnProfile copyWith({String? phone, String? email, String? dob, String? blood, int? height, int? weight}) => MhnProfile(
        name: name, phone: phone ?? this.phone, email: email ?? this.email, dob: dob ?? this.dob, gender: gender,
        blood: blood ?? this.blood, height: height ?? this.height, weight: weight ?? this.weight,
      );

  /// Share of the seven tracked fields that are filled (phone, email, dob, gender, blood, height, weight).
  int get completeness {
    final filled = [phone, email, dob, gender, blood, '$height', '$weight'].where((v) => v.isNotEmpty).length;
    return (filled / 7 * 100).round();
  }
}

@immutable
class MhnMember {
  const MhnMember({required this.id, required this.name, required this.relation, this.gender = '', this.dob = ''});
  final String id;
  final String name;
  final String relation;
  final String gender;
  final String dob;
}

@immutable
class MhnBooking {
  const MhnBooking({required this.id, required this.when, required this.items, required this.who, required this.mode, required this.total, required this.payLabel});
  final String id;
  final String when;
  final List<String> items;
  final String who;
  final String mode; // home | lab
  final int total;
  final String payLabel;
}

@immutable
class MhnState {
  const MhnState({
    this.cart = const [],
    this.who = 'self',
    this.mode = 'home',
    this.day = 0,
    this.slot = -1,
    this.address = '',
    this.pay = 'esewa',
    this.bookings = const [],
    this.member,
    this.memberId = '',
    this.memberUntil = '',
    this.profile = const MhnProfile(name: 'Aayush Shrestha', phone: '9841234567'),
    this.members = const [],
    this.lastId = '',
    this.doneMode = 'home',
    this.calendar = 'BS',
    this.selectedLocationLabel = 'Baneshwor, Kathmandu',
    this.selectedProfileId,
    this.selectedAddressId,
    this.selectedCentreId,
    this.selectedSlotStart,
    this.selectedSlotLabel,
    this.lastBookingNo = '',
    this.lastBooking,
    this.isMockPrototype = false,
  });

  final List<String> cart;
  final String who;
  final String mode;
  final int day;
  final int slot;
  final String address;
  final String pay;
  final List<MhnBooking> bookings;
  final String? member;
  final String memberId;
  final String memberUntil;
  final MhnProfile profile;
  final List<MhnMember> members;
  final String lastId;
  final String doneMode;
  final String calendar;
  final String selectedLocationLabel;
  final String? selectedProfileId;
  final String? selectedAddressId;
  final String? selectedCentreId;
  final String? selectedSlotStart;
  final String? selectedSlotLabel;
  final String lastBookingNo;
  final Map<String, Object?>? lastBooking;
  final bool isMockPrototype;

  bool get isMember => member != null;
  MhnPlan? get plan => member == null ? null : kPlans.firstWhere((p) => p.id == member);

  MhnState copyWith({
    List<String>? cart, String? who, String? mode, int? day, int? slot, String? address, String? pay, List<MhnBooking>? bookings,
    String? member, String? memberId, String? memberUntil, MhnProfile? profile, List<MhnMember>? members, String? lastId, String? doneMode, String? calendar,
    String? selectedLocationLabel,
    String? selectedProfileId, String? selectedAddressId, String? selectedCentreId, String? selectedSlotStart, String? selectedSlotLabel, String? lastBookingNo, Map<String, Object?>? lastBooking,
    bool? isMockPrototype,
  }) =>
      MhnState(
        cart: cart ?? this.cart, who: who ?? this.who, mode: mode ?? this.mode, day: day ?? this.day, slot: slot ?? this.slot,
        address: address ?? this.address, pay: pay ?? this.pay, bookings: bookings ?? this.bookings, member: member ?? this.member,
        memberId: memberId ?? this.memberId, memberUntil: memberUntil ?? this.memberUntil, profile: profile ?? this.profile,
        members: members ?? this.members, lastId: lastId ?? this.lastId, doneMode: doneMode ?? this.doneMode, calendar: calendar ?? this.calendar,
        selectedLocationLabel: selectedLocationLabel ?? this.selectedLocationLabel,
        selectedProfileId: selectedProfileId ?? this.selectedProfileId, selectedAddressId: selectedAddressId ?? this.selectedAddressId,
        selectedCentreId: selectedCentreId ?? this.selectedCentreId, selectedSlotStart: selectedSlotStart ?? this.selectedSlotStart,
        selectedSlotLabel: selectedSlotLabel ?? this.selectedSlotLabel, lastBookingNo: lastBookingNo ?? this.lastBookingNo, lastBooking: lastBooking ?? this.lastBooking,
        isMockPrototype: isMockPrototype ?? this.isMockPrototype,
      );
}

/// One cart line, resolved from a test id or a package id.
@immutable
class MhnCartItem {
  const MhnCartItem(this.id, this.name, this.price, this.meta, this.centre);
  final String id;
  final String name;
  final int price;
  final String meta;
  final bool centre;
}

final Map<String, MhnCartItem> _cartItemRegistry = {};

void registerCartItem(MhnCartItem item) {
  _cartItemRegistry[item.id] = item;
}

MhnCartItem cartItemOf(String id) {
  if (_cartItemRegistry.containsKey(id)) {
    return _cartItemRegistry[id]!;
  }
  for (final t in kTests) {
    if (t.id == id) return MhnCartItem(t.id, t.name, t.price, '${t.fasting} · Report ${t.report}', t.centre);
  }
  for (final p in kPackages) {
    if (p.id == id) return MhnCartItem(p.id, '${p.name} package', p.price, p.params, false);
  }
  return MhnCartItem(id, id, 0, '', false);
}

@immutable
class MhnTotals {
  const MhnTotals(this.sub, [this.save = 0, this.would = 0]);
  final int sub;
  final int save; // 0: paid membership excluded per ADR-SCOPE-001
  final int would; // 0: paid membership excluded per ADR-SCOPE-001
  int get total => sub + homeFee;
}

class MhnController extends Notifier<MhnState> {
  final _rng = Random();

  @override
  MhnState build() => const MhnState();

  /// Next six days; index 0 is "Tmrw". Computed per call so a screen left open past midnight stays right.
  static List<DateTime> days() {
    final n = DateTime.now();
    return [for (var i = 1; i <= 6; i++) DateTime(n.year, n.month, n.day + i)];
  }

  MhnTotals totals() {
    final sub = state.cart.fold<int>(0, (a, id) => a + cartItemOf(id).price);
    return MhnTotals(sub, 0, 0);
  }

  bool get hasImaging => state.cart.any((id) => cartItemOf(id).centre);

  /// Imaging forces a centre visit (the prototype disables home collection then).
  String get effectiveMode => hasImaging ? 'lab' : state.mode;

  void toggleCart(String id) {
    final has = state.cart.contains(id);
    state = state.copyWith(cart: has ? [for (final x in state.cart) if (x != id) x] : [...state.cart, id]);
  }

  void setWho(String v) => state = state.copyWith(who: v);
  void setMode(String v) => state = state.copyWith(mode: v);
  void setDay(int v) => state = state.copyWith(day: v);
  void setSlot(int v) => state = state.copyWith(slot: v);
  void setAddress(String v) => state = state.copyWith(address: v);
  void setPay(String v) => state = state.copyWith(pay: v);
  void toggleCalendar() => state = state.copyWith(calendar: state.calendar == 'BS' ? 'AD' : 'BS');
  void setSelectedProfileId(String? id) => state = state.copyWith(selectedProfileId: id);
  void setSelectedAddressId(String? id) => state = state.copyWith(selectedAddressId: id);
  void setSelectedCentreId(String? id) => state = state.copyWith(selectedCentreId: id);
  void setSelectedSlot({String? slotStart, String? slotLabel}) => state = state.copyWith(
        selectedSlotStart: slotStart,
        selectedSlotLabel: slotLabel,
      );
  void setMockPrototype(bool v) => state = state.copyWith(isMockPrototype: v);

  void recordServerBooking(Map<String, Object?> booking) {
    final id = booking['id'] as String? ?? state.lastId;
    final no = booking['booking_no'] as String? ?? id;
    final mode = (booking['booking_kind'] as String?) == 'home_collection' ? 'home' : 'lab';
    final slotStart = booking['slot_start'] as String?;
    final t = kathmandu(slotStart);
    final when = t != null ? '${weekdayShort(t)} ${t.day} ${monthShort(t)} · ${clock12(t)}' : 'Upcoming appointment';
    final itemsList = mapList(booking['items']);
    final itemNames = [
      for (final it in itemsList)
        (it['display_name'] as String?) ?? (it['orderable_id'] as String? ?? 'Test')
    ];
    // Authoritative total calculated from server returned items
    final serverTotalPaisa = itemsList.fold<int>(0, (sum, it) {
      final pMap = asMap(it['indicative_price']);
      final amount = pMap?['amount_paisa'] as num?;
      return sum + (amount?.toInt() ?? 0);
    });
    final authoritativeTotal = serverTotalPaisa > 0 ? (serverTotalPaisa ~/ 100) : totals().total;

    final b = MhnBooking(
      id: no,
      when: when,
      items: itemNames.isNotEmpty ? itemNames : [for (final c in state.cart) cartItemOf(c).name],
      who: whoName(state.who),
      mode: mode,
      total: authoritativeTotal,
      payLabel: kPays.where((p) => p.id == state.pay).firstOrNull?.label ?? 'Pay on collection',
    );
    state = state.copyWith(
      bookings: [...state.bookings, b],
      lastId: no,
      lastBookingNo: no,
      lastBooking: booking,
      doneMode: mode,
      cart: const [],
      slot: -1,
      selectedSlotStart: null,
      selectedSlotLabel: null,
    );
  }

  String whoName(String id) {
    if (id == 'self') return state.profile.name;
    for (final m in state.members) {
      if (m.id == id) return m.name;
    }
    return state.profile.name;
  }

  /// Simulated payment: creates the booking, empties the cart and returns it.
  MhnBooking confirmBooking() {
    final day = days()[state.day];
    final mode = effectiveMode;
    final t = totals();
    final id = 'MHN-${100000 + _rng.nextInt(900000)}';
    final pay = kPays.firstWhere((p) => p.id == state.pay).label;
    final b = MhnBooking(
      id: id,
      when: '${weekdayShort(day)} ${day.day} ${monthShort(day)} · ${kSlots[state.slot]}',
      items: [for (final c in state.cart) cartItemOf(c).name],
      who: whoName(state.who),
      mode: mode,
      total: t.total,
      payLabel: pay,
    );
    state = state.copyWith(bookings: [...state.bookings, b], lastId: id, doneMode: mode, cart: const [], slot: -1);
    return b;
  }


  void activateMembership(String planId) {
    final until = DateTime.now().add(const Duration(days: 365));
    state = state.copyWith(member: planId, memberId: 'MHN-M-${1000 + _rng.nextInt(9000)}', memberUntil: dateLong(until));
  }

  void setSelectedLocation({String? centreId, required String locationLabel}) {
    state = state.copyWith(
      selectedCentreId: centreId,
      selectedLocationLabel: locationLabel,
    );
  }

  void saveProfile(MhnProfile p) => state = state.copyWith(profile: p);

  void saveMember(MhnMember m, {required bool isNew}) {
    state = state.copyWith(members: isNew ? [...state.members, m] : [for (final x in state.members) x.id == m.id ? m : x]);
  }

  void removeMember(String id) => state = state.copyWith(members: [for (final m in state.members) if (m.id != id) m], who: state.who == id ? 'self' : state.who);

  String newMemberId() => 'm${DateTime.now().microsecondsSinceEpoch}${_rng.nextInt(99)}';
}

final mhnProvider = NotifierProvider<MhnController, MhnState>(MhnController.new);
