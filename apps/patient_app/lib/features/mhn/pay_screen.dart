// Book collection, step 2 of 2: summary + payment method; payment is SIMULATED (prototype). Success replaces the stack with "Confirmed".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'done_screen.dart';
import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnPayScreen extends ConsumerStatefulWidget {
  const MhnPayScreen({super.key});

  @override
  ConsumerState<MhnPayScreen> createState() => _MhnPayScreenState();
}

class _MhnPayScreenState extends ConsumerState<MhnPayScreen> {
  bool _paying = false;

  Future<void> _pay() async {
    setState(() => _paying = true);
    await Future<void>.delayed(const Duration(milliseconds: 1600));
    if (!mounted) return;
    ref.read(mhnProvider.notifier).confirmBooking();
    await Navigator.of(context).pushAndRemoveUntil<void>(MaterialPageRoute<void>(builder: (_) => const MhnDoneScreen()), (r) => r.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final t = ctl.totals();
    final mode = ctl.effectiveMode;
    final day = MhnController.days()[st.day];
    final when = '${weekdayShort(day)} ${day.day} ${monthShort(day)}${st.slot >= 0 ? ' · ${kSlots[st.slot]}' : ''}';
    final where = mode == 'home' ? (st.address.isEmpty ? 'Home' : st.address) : 'Metro Labs, Baneshwor';
    final items = '${st.cart.length} ${st.cart.length == 1 ? 'item' : 'items'}';
    return MhnPage(
      title: 'Review & pay',
      bottom: Column(mainAxisSize: MainAxisSize.min, children: [
        MhnButton(label: _paying ? 'Processing payment…' : (st.pay == 'cash' ? 'Confirm booking' : 'Pay ${rs(t.total)}'), busy: _paying, onPressed: _pay),
        const SizedBox(height: 8),
        Text('Payment is simulated in this prototype.', style: Mhn.small),
      ]),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          MhnCard(
            padding: const EdgeInsets.all(14),
            child: Column(children: [
              _Row('For', ctl.whoName(st.who)),
              _Row('When', when),
              _Row('Where', where),
              _Row('Tests', items),
              const Divider(height: 20, color: Mhn.rowLine),
              Row(children: [Text('Total', style: Mhn.t(16, w: FontWeight.w800)), const Spacer(), Text(rs(t.total), style: Mhn.t(16, w: FontWeight.w800))]),
            ]),
          ),
          const SizedBox(height: 18),
          Text('Pay with', style: Mhn.h2),
          const SizedBox(height: 10),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < kPays.length; i++)
                InkWell(
                  borderRadius: BorderRadius.vertical(top: Radius.circular(i == 0 ? Mhn.rCard : 0), bottom: Radius.circular(i == kPays.length - 1 ? Mhn.rCard : 0)),
                  onTap: _paying ? null : () => ctl.setPay(kPays[i].id),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      color: st.pay == kPays[i].id ? Mhn.limeSoft : Mhn.white,
                      border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null,
                      borderRadius: BorderRadius.vertical(top: Radius.circular(i == 0 ? Mhn.rCard : 0), bottom: Radius.circular(i == kPays.length - 1 ? Mhn.rCard : 0)),
                    ),
                    child: Row(children: [
                      Container(
                        width: 24,
                        height: 24,
                        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: st.pay == kPays[i].id ? Mhn.green : const Color(0xFFAFC2B7), width: 2)),
                        child: st.pay == kPays[i].id ? Center(child: Container(width: 12, height: 12, decoration: const BoxDecoration(shape: BoxShape.circle, color: Mhn.green))) : null,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(kPays[i].label, style: Mhn.t(15, w: FontWeight.w700)),
                          Text(kPays[i].sub, style: Mhn.t(12, c: Mhn.muted)),
                        ]),
                      ),
                    ]),
                  ),
                ),
            ]),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.k, this.v);
  final String k;
  final String v;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(k, style: Mhn.t(14, c: Mhn.muted)),
          const SizedBox(width: 16),
          Expanded(child: Text(v, textAlign: TextAlign.right, style: Mhn.t(14, w: FontWeight.w700))),
        ]),
      );
}
