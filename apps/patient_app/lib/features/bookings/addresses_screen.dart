// A19 Addresses (04-UI-UX A19 field table; 02-TRD §5 E37-E40; US-EN-13.1). List (E37), add (E38, Idempotency-Key per form + body), edit (E39, If-Match = version), remove (E40, If-Match = version; deactivated, never deleted).
// Addresses are P2 PII: LimsSecureScreen, widget state only, never logged / persisted / put in a URL. No map pin in v1: the form has no coordinates. The body never carries an account or patient identifier: the server takes the account from the session.
// LD-140: lims_ui components and token names only; one primary button per page. [CONV] "Add address" opens the same form the wizard's step 4 uses ([AddressFormScreen]).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'bookings_api.dart';
import 'bookings_format.dart';
import 'bookings_providers.dart';

const _labels = addressLabels;
final _e164 = RegExp(r'^\+[1-9][0-9]{7,14}$');

class AddressesScreen extends ConsumerStatefulWidget {
  const AddressesScreen({super.key});

  @override
  ConsumerState<AddressesScreen> createState() => _AddressesScreenState();
}

class _AddressesScreenState extends ConsumerState<AddressesScreen> {
  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  List<Map<String, Object?>> _rows = const [];
  bool _failed = false, _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final body = asMap(await _api.listAddresses());
      if (!mounted) return;
      setState(() {
        _rows = mapList(body?['data']);
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted) setState(() => _failed = true); // never show server detail
    }
  }

  Future<void> _open({Map<String, Object?>? address}) async {
    final r = await Navigator.of(context).push<Object?>(
      MaterialPageRoute<Object?>(
        builder: (_) => AddressFormScreen(address: address),
      ),
    );
    if (!mounted) return;
    await _load();
    if (r == AddressFormScreen.conflict && mounted)
      LimsSnackbar.show(
        context,
        bookingErrorText(LimsException(LimsErrorCodes.commonVersionConflict)),
        tone: 'warning',
      );
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('Addresses')),
      body: Column(
        children: [
          Expanded(child: _body()),
          Padding(
            padding: const EdgeInsets.all(LimsTokens.space4),
            child: SizedBox(
              width: double.infinity,
              child: LimsButton(
                label: 'Add address',
                onPressed: _loaded ? () => _open() : null,
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
            message: 'We could not load your addresses.',
            onRetry: _load,
          ),
        );
      if (!_loaded) return const Center(child: CircularProgressIndicator());
      return const Center(
        child: LimsEmptyState(
          title: 'No saved addresses',
          message: 'Add one to book home collection.',
        ),
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(LimsTokens.space4),
      child: Column(
        children: [
          for (final a in _rows)
            LimsListTile(
              title: '${a['address_text']}',
              subtitle: _labels[a['label']],
              onTap: () => _open(address: a),
            ),
        ],
      ),
    );
  }
}

/// A19 form: add (address == null; [profileId] fixed by the wizard, else the profile is chosen here) or edit (address given). Pops with the saved Address map,
/// [removed] after E40, or [conflict] after a 409 (the caller refetches).
class AddressFormScreen extends ConsumerStatefulWidget {
  const AddressFormScreen({super.key, this.address, this.profileId});

  static const removed = 'removed';
  static const conflict = 'conflict';

  final Map<String, Object?>? address;
  final String? profileId;

  @override
  ConsumerState<AddressFormScreen> createState() => _AddressFormScreenState();
}

class _AddressFormScreenState extends ConsumerState<AddressFormScreen> {
  late final PatientBookingsApi _api = ref.read(patientBookingsApiProvider);
  late final Map<String, Object?>? _a = widget.address;
  late final _text = TextEditingController(text: _s('address_text'));
  late final _landmark = TextEditingController(text: _s('landmark'));
  late final _municipality = TextEditingController(text: _s('municipality'));
  late final _ward = TextEditingController(
    text: _a?['ward_no'] is int ? '${_a!['ward_no']}' : '',
  );
  late final _district = TextEditingController(text: _s('district'));
  late final _phone = TextEditingController(text: _s('contact_phone_e164'));
  late String _label = _labels.containsKey(_a?['label'])
      ? _a!['label']! as String
      : 'home';
  String? _profile,
      _key,
      _keyBody,
      _textError,
      _wardError,
      _phoneError,
      _notice;
  bool _busy = false;

  String _s(String k) => _a?[k] is String ? _a![k]! as String : '';

  @override
  void initState() {
    super.initState();
    _profile = _a?['profile_id'] is String
        ? _a!['profile_id']! as String
        : widget.profileId;
  }

  @override
  void dispose() {
    for (final c in [
      _text,
      _landmark,
      _municipality,
      _ward,
      _district,
      _phone,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Local validation (04-UI-UX A19): address 1-300 (not blank), ward 1-99, phone E.164. Returns the body, or null after showing the field errors.
  Map<String, Object?>? _body() {
    final text = _text.text.trim(),
        ward = _ward.text.trim(),
        phone = _phone.text.trim();
    final wardNo = ward.isEmpty ? null : int.tryParse(ward);
    setState(() {
      _textError = text.isEmpty ? 'Enter the address' : null;
      _wardError =
          ward.isNotEmpty && (wardNo == null || wardNo < 1 || wardNo > 99)
          ? 'Enter a number from 1 to 99'
          : null;
      _phoneError = phone.isNotEmpty && !_e164.hasMatch(phone)
          ? 'Use the international format, e.g. +977…'
          : null;
    });
    if (_textError != null ||
        _wardError != null ||
        _phoneError != null ||
        _profile == null)
      return null;
    String? opt(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    return {
      'profile_id': _profile,
      'label': _label,
      'address_text': text,
      if (opt(_landmark) != null) 'landmark': opt(_landmark),
      if (opt(_municipality) != null) 'municipality': opt(_municipality),
      if (wardNo != null) 'ward_no': wardNo,
      if (opt(_district) != null) 'district': opt(_district),
      if (phone.isNotEmpty) 'contact_phone_e164': phone,
    };
  }

  Future<void> _save() async {
    if (_busy) return;
    final body = _body();
    if (body == null) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final Object? saved;
      if (_a == null) {
        final sig = jsonEncode(body);
        if (_keyBody != sig) {
          _key = newIdempotencyKey(); // a retry of the same body reuses the key (P-8); a changed body is a new request
          _keyBody = sig;
        }
        saved = await _api.createAddress(body: body, idempotencyKey: _key!);
      } else {
        saved = await _api.updateAddress(
          addressId: '${_a['id']}',
          version: _a['version'] is int ? _a['version']! as int : 0,
          body: body,
        );
      }
      if (!mounted) return;
      Navigator.of(context).pop(asMap(saved) ?? AddressFormScreen.removed);
    } on Object catch (e) {
      if (!mounted) return;
      if (e is LimsException &&
          e.code == LimsErrorCodes.commonVersionConflict) {
        Navigator.of(context).pop(AddressFormScreen.conflict);
        return;
      }
      setState(
        () => _notice = bookingErrorText(e),
      ); // the form stays open with the typed text
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove() async {
    final a = _a;
    if (a == null || _busy) return;
    final ok = await LimsConfirmDialog.show(
      context,
      title: 'Remove this address?',
      message: 'Bookings that already use it keep it.',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
    );
    if (ok == null || !mounted) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await _api.deactivateAddress(
        addressId: '${a['id']}',
        version: a['version'] is int ? a['version']! as int : 0,
      );
      if (mounted) Navigator.of(context).pop(AddressFormScreen.removed);
    } on Object catch (e) {
      if (!mounted) return;
      if (e is LimsException &&
          e.code == LimsErrorCodes.commonVersionConflict) {
        Navigator.of(context).pop(AddressFormScreen.conflict);
        return;
      }
      setState(() {
        _notice = bookingErrorText(e);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final profiles = _a == null && widget.profileId == null
        ? ref.watch(bookingProfilesProvider).value ?? const <BookingProfile>[]
        : const <BookingProfile>[];
    if (_profile == null && profiles.isNotEmpty)
      _profile = profiles
          .first
          .id; // [CONV] the first profile until the person picks another
    return LimsSecureScreen(
      child: Scaffold(
        appBar: AppBar(
          title: Text(_a == null ? 'New address' : 'Edit address'),
        ),
        body: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(LimsTokens.space4),
                child: Column(
                  children: [
                    if (_notice != null) ...[
                      BookingBanner(text: _notice!),
                      const SizedBox(height: LimsTokens.space3),
                    ],
                    if (profiles.length > 1) ...[
                      for (final p in profiles)
                        ChoiceRow(
                          title: p.displayName,
                          selected: p.id == _profile,
                          onTap: () => setState(() => _profile = p.id),
                        ),
                      const SizedBox(height: LimsTokens.space3),
                    ],
                    LimsTextField(
                      label: 'Address',
                      maxLength: 300,
                      controller: _text,
                      errorText: _textError,
                    ),
                    LimsSegmentedControl<String>(
                      options: [
                        for (final e in _labels.entries)
                          (value: e.key, label: e.value),
                      ],
                      value: _label,
                      onChanged: (v) => setState(() => _label = v),
                    ),
                    LimsTextField(
                      label: 'Landmark',
                      maxLength: 120,
                      controller: _landmark,
                    ),
                    LimsTextField(
                      label: 'Municipality',
                      maxLength: 80,
                      controller: _municipality,
                    ),
                    LimsTextField(
                      label: 'Ward no.',
                      maxLength: 2,
                      controller: _ward,
                      errorText: _wardError,
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    ),
                    LimsTextField(
                      label: 'District',
                      maxLength: 60,
                      controller: _district,
                    ),
                    LimsTextField(
                      label: 'Contact phone',
                      maxLength: 15,
                      controller: _phone,
                      errorText: _phoneError,
                      keyboardType: TextInputType.phone,
                      sensitive: true,
                    ),
                  ],
                ),
              ),
            ),
            // pinned below the scroll area so Save / Remove stay reachable on a long form
            Padding(
              padding: const EdgeInsets.all(LimsTokens.space4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: LimsButton(
                      label: 'Save',
                      onPressed: _busy ? null : _save,
                    ),
                  ),
                  if (_a != null) ...[
                    const SizedBox(height: LimsTokens.space2),
                    SizedBox(
                      width: double.infinity,
                      child: LimsButton(
                        label: 'Remove address',
                        secondary: true,
                        onPressed: _busy ? null : _remove,
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
}
