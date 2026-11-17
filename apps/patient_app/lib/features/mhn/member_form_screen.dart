// Add / edit a family member: name, relation, gender, date of birth (AD); delete when editing.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMemberFormScreen extends ConsumerStatefulWidget {
  const MhnMemberFormScreen({super.key, this.editing});
  final MhnMember? editing;

  @override
  ConsumerState<MhnMemberFormScreen> createState() => _MhnMemberFormScreenState();
}

class _MhnMemberFormScreenState extends ConsumerState<MhnMemberFormScreen> {
  late final TextEditingController _name;
  late String _rel;
  late String _gender;
  late String _dob;
  String _err = '';

  @override
  void initState() {
    super.initState();
    final m = widget.editing;
    _name = TextEditingController(text: m?.name ?? '');
    _rel = m?.relation ?? '';
    _gender = m?.gender ?? '';
    _dob = m?.dob ?? '';
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final d = await showDatePicker(context: context, initialDate: DateTime.tryParse(_dob) ?? DateTime(now.year - 20, now.month, now.day), firstDate: DateTime(1900), lastDate: now.add(const Duration(days: 365)), helpText: 'Date of birth (AD)');
    if (d != null) {
      setState(() {
        _dob = '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
        _err = '';
      });
    }
  }

  void _save() {
    final name = _name.text.trim();
    if (name.length < 2) return setState(() => _err = 'Enter the member’s full name.');
    if (_rel.isEmpty) return setState(() => _err = 'Choose how they are related to you.');
    if (_dob.isNotEmpty && (ageFrom(_dob) ?? 0) < 0) return setState(() => _err = 'Date of birth cannot be in the future.');
    final ctl = ref.read(mhnProvider.notifier);
    final isNew = widget.editing == null;
    ctl.saveMember(MhnMember(id: widget.editing?.id ?? ctl.newMemberId(), name: name, relation: _rel, gender: _gender, dob: _dob), isNew: isNew);
    mhnToast(context, isNew ? '${name.split(' ').first} added to your family' : 'Changes saved for ${name.split(' ').first}');
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.editing != null;
    return MhnPage(
      title: editing ? 'Edit member' : 'Add member',
      bottom: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_err.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_err, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.danger))),
        MhnButton(label: editing ? 'Save changes' : 'Add member', onPressed: _save),
        if (editing)
          TextButton(
            onPressed: () {
              final n = widget.editing!.name.split(' ').first;
              ref.read(mhnProvider.notifier).removeMember(widget.editing!.id);
              mhnToast(context, '$n removed');
              Navigator.of(context).pop();
            },
            child: Text('Remove member', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.danger)),
          ),
      ]),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          MhnField(label: 'Full name', controller: _name, hint: 'e.g. Sita Shrestha', onChanged: (_) => setState(() => _err = '')),
          const SizedBox(height: 16),
          Text('Relation', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [for (final r in kRelations) MhnChip(label: r, selected: _rel == r, radius: 999, onTap: () => setState(() { _rel = r; _err = ''; }))]),
          const SizedBox(height: 16),
          Text('Gender', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 8),
          Row(children: [
            for (var i = 0; i < kGenders.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              Expanded(child: MhnChip(label: kGenders[i], selected: _gender == kGenders[i], radius: 12, onTap: () => setState(() => _gender = _gender == kGenders[i] ? '' : kGenders[i]))),
            ],
          ]),
          const SizedBox(height: 16),
          Text('Date of birth (AD)', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 6),
          InkWell(
            borderRadius: BorderRadius.circular(Mhn.rField),
            onTap: _pickDob,
            child: Container(
              height: 52,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(color: Mhn.limeSoft, borderRadius: BorderRadius.circular(Mhn.rField), border: Border.all(color: Mhn.limeLine)),
              child: Row(children: [
                Expanded(child: Text(_dob.isEmpty ? 'dd/mm/yyyy' : dateLong(DateTime.parse(_dob)), style: Mhn.t(15, w: FontWeight.w600, c: _dob.isEmpty ? Mhn.mutedSoft : Mhn.ink))),
                const Icon(Icons.calendar_today_outlined, size: 18, color: Mhn.green),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
