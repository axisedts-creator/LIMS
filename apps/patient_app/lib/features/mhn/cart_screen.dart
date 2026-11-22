// Cart: lines with remove, subtotal, free home collection, total, member-saving nudge and "Choose date & time".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'book_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnCartScreen extends ConsumerWidget {
  const MhnCartScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(mhnProvider);
    final ctl = ref.read(mhnProvider.notifier);
    final t = ctl.totals();
    final mode = ctl.effectiveMode;
    if (st.cart.isEmpty) {
      return MhnPage(
        title: 'Cart',
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const MhnIconTile(Icons.shopping_cart_outlined, size: 64),
              const SizedBox(height: 16),
              Text('Your cart is empty', style: Mhn.t(17, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text('Add tests or a health package to book a collection.', textAlign: TextAlign.center, style: Mhn.body),
              const SizedBox(height: 20),
              MhnButton(
                label: 'Browse tests',
                onPressed: () {
                  ref.read(mhnTabProvider.notifier).go(mhnTabTests);
                  Navigator.of(context).popUntil((r) => r.isFirst);
                },
              ),
            ]),
          ),
        ),
      );
    }
    return MhnPage(
      title: 'Cart',
      bottom: MhnButton(label: 'Choose date & time', onPressed: () => mhnPush<void>(context, const MhnBookScreen())),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < st.cart.length; i++)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(cartItemOf(st.cart[i]).name, style: Mhn.t(15, w: FontWeight.w700)),
                        Text(cartItemOf(st.cart[i]).meta, style: Mhn.t(12, c: Mhn.muted)),
                      ]),
                    ),
                    Text(rs(cartItemOf(st.cart[i]).price), style: Mhn.t(14, w: FontWeight.w800)),
                    IconButton(
                      tooltip: 'Remove ${cartItemOf(st.cart[i]).name}',
                      onPressed: () => ctl.toggleCart(st.cart[i]),
                      icon: const Icon(Icons.delete_outline, size: 20, color: Mhn.dangerFg),
                    ),
                  ]),
                ),
            ]),
          ),
          const SizedBox(height: 12),
          MhnCard(
            padding: const EdgeInsets.all(14),
            child: Column(children: [
              _Line('Estimated subtotal', rs(t.sub)),
              _Line('Collection method', mode == 'home' ? 'Home collection' : 'Centre visit'),
              const Divider(height: 22, color: Mhn.rowLine),
              Row(children: [
                Text('Estimated total', style: Mhn.t(17, w: FontWeight.w800)),
                const Spacer(),
                Text(rs(t.sub), style: Mhn.t(17, w: FontWeight.w800)),
              ]),
              const SizedBox(height: 6),
              Align(alignment: Alignment.centerLeft, child: Text('Prices shown are indicative. Final quote is confirmed at booking review.', style: Mhn.small)),
            ]),
          ),
        ],
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line(this.k, this.v);
  final String k;
  final String v;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [Text(k, style: Mhn.t(14, c: Mhn.muted)), const Spacer(), Text(v, style: Mhn.t(14, c: Mhn.muted))]),
      );
}
