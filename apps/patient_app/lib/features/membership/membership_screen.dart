// A21 Membership card (04-UI-UX A21; 03-APP-FLOW §10.1; US-EN-17.3; 07-SECURITY "Membership card QR"). One LimsCard per card in API order: plan name, card number
// (monospace), "Valid {from} – {to}", status word and the QR of card_token. The token is a secret: it only feeds the QR (never text, log, clipboard or storage).
// LD-140: lims_ui widgets and tokens only. PHI screen -> LimsSecureScreen (REQ-SEC-109). States: skeleton, "No membership", error + Retry.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import 'membership_providers.dart';

const _qrSize = 240.0; // >= 200 logical px so a front-desk scanner reads it
const _statusWord = {'active': 'Active', 'cancelled': 'Cancelled', 'expired': 'Expired'};
const _statusTone = {'active': 'success', 'cancelled': 'neutral', 'expired': 'warning'};

String _dmy(String iso) => RegExp(r'^\d{4}-\d{2}-\d{2}').hasMatch(iso) ? '${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}' : iso;

class MembershipScreen extends ConsumerStatefulWidget {
  const MembershipScreen({super.key});

  @override
  ConsumerState<MembershipScreen> createState() => _MembershipScreenState();
}

class _MembershipScreenState extends ConsumerState<MembershipScreen> {
  late final CardBrightness _brightness = ref.read(cardBrightnessProvider); // captured: ref is not usable in dispose
  bool _raised = false;

  @override
  void initState() {
    super.initState();
    ref.listenManual(myMembershipsProvider, (_, next) {
      final cards = next.value;
      if (cards != null && cards.isNotEmpty && !_raised) {
        _raised = true;
        unawaited(_bestEffort(_brightness.raise));
      }
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    if (_raised) unawaited(_bestEffort(_brightness.restore));
    super.dispose();
  }

  Future<void> _bestEffort(Future<void> Function() call) async {
    try {
      await call();
    } catch (_) {
      // no brightness hook: the card still works
    }
  }

  @override
  Widget build(BuildContext context) {
    final cards = ref.watch(myMembershipsProvider);
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Membership',
        body: cards.when(
          loading: () => const LimsLoading(),
          error: (_, __) => LimsErrorState(
            title: 'Could not load your membership',
            message: 'Check your connection and try again.',
            onRetry: () => ref.invalidate(myMembershipsProvider),
          ),
          data: (list) => list.isEmpty
              ? const LimsEmptyState(title: 'No membership', message: 'Ask the front desk about membership plans.')
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(LimsTokens.space4),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text('Show this at the front desk.', style: Theme.of(context).textTheme.bodyLarge),
                    for (final c in list) ...[const SizedBox(height: LimsTokens.space4), _CardView(c)],
                  ]),
                ),
        ),
      ),
    );
  }
}

class _CardView extends StatelessWidget {
  const _CardView(this.c);

  final MembershipCardData c;

  @override
  Widget build(BuildContext context) => LimsCard(
        title: c.planName,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(c.cardNo, style: const TextStyle(fontFamily: LimsTheme.monoFamily)),
          const SizedBox(height: LimsTokens.space1),
          Text('Valid ${_dmy(c.validFrom)} – ${_dmy(c.validTo)}'),
          const SizedBox(height: LimsTokens.space2),
          LimsStatusChip(kind: 'generic', status: c.status, label: _statusWord[c.status] ?? c.status, tone: _statusTone[c.status] ?? 'neutral'),
          const SizedBox(height: LimsTokens.space4),
          Center(child: LimsQrCode(data: c.token, size: _qrSize, semanticLabel: 'Membership QR code')),
        ]),
      );
}
