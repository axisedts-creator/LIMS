// Book collection, step 1 of 2: who, where (home / centre), address, date, time slot. Validation wording is the prototype's.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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

  @override
  void initState() {
    super.initState();
    _address = TextEditingController(text: ref.read(mhnProvider).address);
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  void _next() {
    final st = ref.read(mhnProvider);
    final mode = ref.read(mhnProvider.notifier).effectiveMode;
    if (st.slot < 0) return setState(() => _err = 'Choose a time slot.');
    if (mode == 'home' && st.address.trim().length < 6) return setState(() => _err = 'Enter the full collection address.');
    setState(() => _err = '');
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
    return MhnPage(
      title: 'Book collection',
      bottom: Column(mainAxisSize: MainAxisSize.min, children: [
        if (_err.isNotEmpty)
          Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_err, style: Mhn.t(13, w: FontWeight.w700, c: Mhn.danger))),
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
          Wrap(spacing: 8, runSpacing: 8, children: [
            MhnChip(label: '$firstName (you)', selected: st.who == 'self', radius: 14, onTap: () => ctl.setWho('self')),
            for (final m in st.members)
              MhnChip(label: '${m.name.split(' ').first} · ${m.relation}', selected: st.who == m.id, radius: 14, onTap: () => ctl.setWho(m.id)),
            Material(
              color: Mhn.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: Mhn.green)),
              child: InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => mhnPush<void>(context, const MhnMemberFormScreen()),
                child: Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12), child: Text('+ Add member', style: Mhn.t(14, w: FontWeight.w600, c: Mhn.green))),
              ),
            ),
          ]),
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
                  onTap: () => forceLab ? mhnToast(context, 'Imaging needs a centre visit') : ctl.setMode('home'),
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(child: MhnChip(label: 'Centre visit', selected: mode == 'lab', radius: 14, onTap: () => ctl.setMode('lab'))),
          ]),
          if (mode == 'home') ...[
            const SizedBox(height: 14),
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
          const SizedBox(height: 20),
          Text('Date', style: Mhn.h2),
          const SizedBox(height: 10),
          SizedBox(
            height: 76,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: days.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (_, i) => SizedBox(
                width: 62,
                child: MhnChip(
                  label: i == 0 ? 'Tmrw' : weekdayShort(days[i]),
                  sub: '${days[i].day}\n${monthShort(days[i])}',
                  selected: st.day == i,
                  radius: 14,
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  onTap: () {
                    ctl.setDay(i);
                    setState(() => _err = '');
                  },
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text('Time', style: Mhn.h2),
          const SizedBox(height: 10),
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
      ),
    );
  }
}
