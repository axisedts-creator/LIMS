// Edit profile: phone, email, date of birth (AD), blood group, height / weight steppers. Validation wording is the prototype's.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnEditProfileScreen extends ConsumerStatefulWidget {
  const MhnEditProfileScreen({super.key});

  @override
  ConsumerState<MhnEditProfileScreen> createState() => _MhnEditProfileScreenState();
}

class _MhnEditProfileScreenState extends ConsumerState<MhnEditProfileScreen> {
  late final TextEditingController _phone;
  late final TextEditingController _email;
  late String _dob;
  late String _blood;
  late int _height;
  late int _weight;
  bool _saving = false;
  final _err = <String, String>{};

  @override
  void initState() {
    super.initState();
    final p = ref.read(mhnProvider).profile;
    _phone = TextEditingController(text: p.phone);
    _email = TextEditingController(text: p.email);
    _dob = p.dob;
    _blood = p.blood;
    _height = p.height;
    _weight = p.weight;
  }

  @override
  void dispose() {
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Map<String, String> _validate() {
    final e = <String, String>{};
    if (!RegExp(r'^9[678]\d{8}$').hasMatch(_phone.text.trim())) e['phone'] = 'Enter a 10-digit mobile number starting with 96, 97 or 98.';
    final mail = _email.text.trim();
    if (mail.isNotEmpty && !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$').hasMatch(mail)) e['email'] = 'Enter a valid email address.';
    if (_dob.isNotEmpty) {
      final a = ageFrom(_dob);
      if (a == null || a < 0) {
        e['dob'] = 'Date of birth cannot be in the future.';
      } else if (a > 120) {
        e['dob'] = 'Please check the year.';
      }
    }
    return e;
  }

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final initial = DateTime.tryParse(_dob) ?? DateTime(now.year - 30, now.month, now.day);
    final d = await showDatePicker(context: context, initialDate: initial.isAfter(now) ? now : initial, firstDate: DateTime(1900), lastDate: now.add(const Duration(days: 365)), helpText: 'Date of birth (AD)');
    if (d == null) return;
    setState(() {
      _dob = '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
      _err.remove('dob');
    });
  }

  Future<void> _save() async {
    final e = _validate();
    if (e.isNotEmpty) {
      setState(() => _err..clear()..addAll(e));
      return;
    }
    setState(() => _saving = true);
    await Future<void>.delayed(const Duration(milliseconds: 700));
    if (!mounted) return;
    ref.read(mhnProvider.notifier).saveProfile(ref.read(mhnProvider).profile.copyWith(phone: _phone.text.trim(), email: _email.text.trim(), dob: _dob, blood: _blood, height: _height, weight: _weight));
    mhnToast(context, 'Profile saved');
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final age = _dob.isEmpty ? null : ageFrom(_dob);
    return MhnPage(
      title: 'Edit profile',
      bottom: MhnButton(label: _saving ? 'Saving…' : 'Save', busy: _saving, onPressed: _save),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          MhnField(
            label: 'Phone number',
            controller: _phone,
            prefix: '+977  ',
            keyboardType: TextInputType.number,
            error: _err['phone'],
            onChanged: (_) => setState(() => _err.remove('phone')),
          ),
          const SizedBox(height: 14),
          MhnField(label: 'Email', controller: _email, hint: 'name@example.com', keyboardType: TextInputType.emailAddress, error: _err['email'], onChanged: (_) => setState(() => _err.remove('email'))),
          const SizedBox(height: 14),
          Text('Date of birth (AD)', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 6),
          InkWell(
            borderRadius: BorderRadius.circular(Mhn.rField),
            onTap: _pickDob,
            child: Container(
              height: 52,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(color: Mhn.limeSoft, borderRadius: BorderRadius.circular(Mhn.rField), border: Border.all(color: _err['dob'] != null ? Mhn.danger : Mhn.limeLine)),
              child: Row(children: [
                Expanded(child: Text(_dob.isEmpty ? 'dd/mm/yyyy' : dateLong(DateTime.parse(_dob)), style: Mhn.t(15, w: FontWeight.w600, c: _dob.isEmpty ? Mhn.mutedSoft : Mhn.ink))),
                const Icon(Icons.calendar_today_outlined, size: 18, color: Mhn.green),
              ]),
            ),
          ),
          if (_err['dob'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_err['dob']!, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.danger))),
          if (_err['dob'] == null && age != null && age >= 0) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${dateLong(DateTime.parse(_dob))} · $age years old', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted))),
          const SizedBox(height: 18),
          Text('Blood group', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 8),
          LayoutBuilder(builder: (context, c) {
            final w = (c.maxWidth - 3 * 8) / 4;
            return Wrap(spacing: 8, runSpacing: 8, children: [
              for (final b in kBlood) SizedBox(width: w, child: MhnChip(label: b, selected: _blood == b, radius: 12, padding: const EdgeInsets.symmetric(vertical: 12), onTap: () => setState(() => _blood = _blood == b ? '' : b))),
            ]);
          }),
          const SizedBox(height: 18),
          Row(children: [
            Expanded(child: _Stepper(label: 'Height', unit: 'cm', value: _height, onChanged: (v) => setState(() => _height = v.clamp(50, 250)))),
            const SizedBox(width: 12),
            Expanded(child: _Stepper(label: 'Weight', unit: 'kg', value: _weight, onChanged: (v) => setState(() => _weight = v.clamp(2, 300)))),
          ]),
        ],
      ),
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({required this.label, required this.unit, required this.value, required this.onChanged});
  final String label;
  final String unit;
  final int value;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: Mhn.limeSoft, borderRadius: BorderRadius.circular(Mhn.rCard), border: Border.all(color: Mhn.limeLine)),
        child: Column(children: [
          Text(label, style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 4),
          Text.rich(TextSpan(children: [TextSpan(text: '$value', style: Mhn.t(26, w: FontWeight.w800)), TextSpan(text: ' $unit', style: Mhn.t(14, w: FontWeight.w600, c: Mhn.muted))])),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            _Btn(Icons.remove, 'Decrease $label', () => onChanged(value - 1)),
            const SizedBox(width: 10),
            _Btn(Icons.add, 'Increase $label', () => onChanged(value + 1)),
          ]),
        ]),
      );
}

class _Btn extends StatelessWidget {
  const _Btn(this.icon, this.label, this.onTap);
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        child: Material(
          color: Mhn.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: const BorderSide(color: Mhn.lineStrong)),
          child: InkWell(borderRadius: BorderRadius.circular(10), onTap: onTap, child: SizedBox(width: 44, height: 40, child: Icon(icon, size: 20, color: Mhn.green))),
        ),
      );
}
