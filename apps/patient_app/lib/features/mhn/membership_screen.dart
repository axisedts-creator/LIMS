// Membership: two plan cards (Individual Rs 999 / Family Rs 1,999 per year), benefits, activate (simulated). Active members see their card.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMembershipScreen extends ConsumerStatefulWidget {
  const MhnMembershipScreen({super.key});

  @override
  ConsumerState<MhnMembershipScreen> createState() => _MhnMembershipScreenState();
}

class _MhnMembershipScreenState extends ConsumerState<MhnMembershipScreen> {
  String? _sel;
  bool _busy = false;

  Future<void> _activate(MhnState st) async {
    final sel = _sel ?? st.member ?? 'individual';
    if (st.isMember) {
      mhnToast(context, sel != st.member ? 'You can switch plans when your membership renews' : 'Your membership is already active');
      return;
    }
    setState(() => _busy = true);
    await Future<void>.delayed(const Duration(milliseconds: 1400));
    if (!mounted) return;
    ref.read(mhnProvider.notifier).activateMembership(sel);
    setState(() => _busy = false);
    mhnToast(context, 'Membership active. Member prices now apply.');
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final sel = _sel ?? st.member ?? 'individual';
    final plan = kPlans.firstWhere((p) => p.id == sel);
    final cta = st.isMember ? (sel != st.member ? 'Switch at renewal' : 'Membership active') : 'Activate ${plan.name} · ${rs(plan.price)}';
    return MhnPage(
      title: 'Membership',
      bottom: MhnButton(label: _busy ? 'Activating…' : cta, busy: _busy, onPressed: () => _activate(st)),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(st.isMember ? 'You can switch plan when your membership renews.' : 'Choose a plan. Member prices apply from your next booking.', style: Mhn.body),
          const SizedBox(height: 14),
          if (st.isMember) ...[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: Mhn.limeSoft, borderRadius: BorderRadius.circular(Mhn.rCard), border: Border.all(color: Mhn.limeLine)),
              child: Row(children: [
                const MhnIconTile(Icons.workspace_premium_outlined, size: 44, bg: Mhn.lime),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${st.plan!.name} · Active', style: Mhn.t(15, w: FontWeight.w800)),
                    Text('Member ID ${st.memberId} · valid until ${st.memberUntil}', style: Mhn.t(12, c: Mhn.muted)),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 14),
          ],
          for (final p in kPlans)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: GestureDetector(
                onTap: () => setState(() => _sel = p.id),
                child: Container(
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(Mhn.rCard + 3), border: Border.all(color: sel == p.id ? Mhn.limeStrong : Colors.transparent, width: 2)),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(Mhn.rCard),
                    child: Container(
                      color: p.color,
                      child: Stack(children: [
                        Positioned(right: -50, top: -50, child: Container(width: 160, height: 160, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: const Color(0x1AFFFFFF), width: 22)))),
                        Padding(
                          padding: const EdgeInsets.all(18),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Expanded(child: Text(p.name, style: Mhn.t(17, w: FontWeight.w800, c: Mhn.white))),
                              Container(
                                width: 26,
                                height: 26,
                                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Mhn.white, width: 2)),
                                child: sel == p.id ? Center(child: Container(width: 12, height: 12, decoration: const BoxDecoration(shape: BoxShape.circle, color: Mhn.lime))) : null,
                              ),
                            ]),
                            const SizedBox(height: 8),
                            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                              Flexible(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(rs(p.price), style: Mhn.t(32, w: FontWeight.w800, c: Mhn.white)))),
                              Padding(padding: const EdgeInsets.only(left: 6, bottom: 6), child: Text('/ year', style: Mhn.t(13, c: const Color(0xCCFFFFFF)))),
                            ]),
                            const SizedBox(height: 6),
                            Text(p.desc, style: Mhn.t(14, c: const Color(0xE6FFFFFF), h: 1.35)),
                          ]),
                        ),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
          MhnCard(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Benefits', style: Mhn.t(15, w: FontWeight.w800)),
              const SizedBox(height: 10),
              for (final b in const ['10% member price on tests and packages', 'Free home collection on every booking', 'Priority morning slots'])
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Padding(padding: EdgeInsets.only(top: 2), child: Icon(Icons.check, size: 17, color: Mhn.green)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(b, style: Mhn.t(14, h: 1.3))),
                  ]),
                ),
              const SizedBox(height: 6),
              Text('Sample terms. Metro Labs to confirm prices and benefits.', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.warnFg)),
            ]),
          ),
        ],
      ),
    );
  }
}
