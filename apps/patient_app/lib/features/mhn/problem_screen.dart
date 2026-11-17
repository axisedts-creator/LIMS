// Report a problem: type chips, optional related booking, description (min 10 characters); creates a sample ticket id.
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnProblemScreen extends ConsumerStatefulWidget {
  const MhnProblemScreen({super.key});

  @override
  ConsumerState<MhnProblemScreen> createState() => _MhnProblemScreenState();
}

class _MhnProblemScreenState extends ConsumerState<MhnProblemScreen> {
  final _text = TextEditingController();
  String _kind = '';
  String _booking = '';
  String _err = '';

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _send() {
    if (_kind.isEmpty) return setState(() => _err = 'Choose what the problem is about.');
    if (_text.text.trim().length < 10) return setState(() => _err = 'Add a short description (at least 10 characters).');
    mhnToast(context, 'Thanks. Ticket MHN-T-${1000 + Random().nextInt(9000)} created.');
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final bookings = ref.watch(mhnProvider.select((s) => s.bookings)).reversed.toList();
    return MhnPage(
      title: 'Report a problem',
      bottom: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_err.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_err, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.danger))),
        MhnButton(label: 'Send report', onPressed: _send),
      ]),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('What went wrong?', style: Mhn.t(15, w: FontWeight.w800)),
          const SizedBox(height: 10),
          Wrap(spacing: 8, runSpacing: 8, children: [for (final k in kProblems) MhnChip(label: k, selected: _kind == k, radius: 999, onTap: () => setState(() { _kind = k; _err = ''; }))]),
          if (bookings.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text('Related booking (optional)', style: Mhn.t(13, w: FontWeight.w700, c: Mhn.muted)),
            const SizedBox(height: 8),
            for (final b in bookings)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => setState(() => _booking = _booking == b.id ? '' : b.id),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: _booking == b.id ? Mhn.limeSoft : Mhn.white, borderRadius: BorderRadius.circular(14), border: Border.all(color: _booking == b.id ? Mhn.green : Mhn.line)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${b.id} · ${b.when}', style: Mhn.t(13, w: FontWeight.w800)),
                      Text(b.items.join(', '), style: Mhn.t(12, c: Mhn.muted)),
                    ]),
                  ),
                ),
              ),
          ],
          const SizedBox(height: 18),
          MhnField(label: 'Describe it briefly', controller: _text, hint: 'What happened, and when?', maxLines: 4, onChanged: (_) => setState(() => _err = '')),
        ],
      ),
    );
  }
}
