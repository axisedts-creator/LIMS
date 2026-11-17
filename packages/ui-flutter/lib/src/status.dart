// 04-UI-UX §1.3 status mapping — same rows as packages/ui/src/components/StatusChip/StatusChip.tsx (AC-0D-9.2).
import 'package:flutter/material.dart';

import 'theme.dart';
import 'tokens.g.dart';

/// kind -> status -> (tone, English label). Label keys are `ui.status.<kind>.<status>`.
const _map = <String, Map<String, (String, String)>>{
  'specimen': {
    'ordered': ('neutral', 'Ordered'),
    'collected': ('info', 'Collected'),
    'in_transit': ('info', 'In transit'),
    'received': ('info', 'Received'),
    'aliquoted': ('info', 'Aliquoted'),
    'in_process': ('info', 'In process'),
    'resulted': ('warning', 'Resulted'),
    'verified': ('warning', 'Verified'),
    'approved': ('success', 'Approved'),
    'reported': ('success', 'Reported'),
    'rejected': ('danger', 'Rejected'),
    'recollection_ordered': ('warning', 'Recollection ordered'),
    'stored': ('neutral', 'Stored'),
    'discarded': ('neutral', 'Discarded'),
  },
  'result': {
    'pending': ('neutral', 'Pending'),
    'resulted': ('warning', 'Resulted'),
    'verified': ('warning', 'Verified'),
    'approved': ('success', 'Approved'),
    'cancelled': ('neutral', 'Cancelled'),
    'on_hold': ('warning', 'QC hold'),
    'qc_review_required': ('warning', 'QC review'),
  },
  'report_version': {
    'rendering': ('info', 'Rendering'),
    'rendered': ('info', 'Ready to release'),
    'render_failed': ('danger', 'Render failed'),
    'released': ('success', 'Released'),
    'superseded': ('neutral', 'Superseded'),
    'discarded': ('neutral', 'Discarded'),
  },
  'order': {
    'pre_registered': ('neutral', 'Pre-registered'),
    'registered': ('info', 'Registered'),
    'in_progress': ('info', 'In progress'),
    'completed': ('success', 'Completed'),
    'cancelled': ('danger', 'Cancelled'),
  },
  'invoice': {
    'issued': ('success', 'Issued'),
    'cancelled': ('danger', 'Cancelled'),
  },
  'payment_intent': {
    'created': ('info', 'Created'),
    'initiated': ('info', 'Initiated'),
    'pending': ('info', 'Pending'),
    'settled': ('success', 'Paid'),
    'failed': ('danger', 'Failed'),
    'expired': ('danger', 'Expired'),
    'held_for_review': ('warning', 'Under review'),
    'refunded': ('neutral', 'Refunded'),
    'partially_refunded': ('neutral', 'Partially refunded'),
  },
  'dead_letter': {
    'open': ('danger', 'Open'),
    'replayed': ('success', 'Replayed'),
    'discarded': ('neutral', 'Discarded'),
  },
};

Widget _chip(String tone, List<Widget> children) {
  final c = limsTone(tone);
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space2, vertical: LimsTokens.space0x5),
    decoration: BoxDecoration(
      color: c.bg,
      border: Border.all(color: c.border),
      borderRadius: BorderRadius.circular(LimsTokens.radiusFull),
    ),
    child: Row(mainAxisSize: MainAxisSize.min, children: children),
  );
}

/// Status chip; unknown kind/status -> neutral chip with the raw code (x-extensible enums, CV §4.11).
class LimsStatusChip extends StatelessWidget {
  const LimsStatusChip({super.key, required this.kind, required this.status, String? tone, this.label}) : _tone = tone;

  final String kind;
  final String status;
  final String? _tone; // only for kind 'generic'
  final String? label; // only for kind 'generic'

  (String, String) get _row {
    if (kind == 'generic') return (limsTones.containsKey(_tone) ? _tone! : 'neutral', label ?? status);
    return _map[kind]?[status] ?? ('neutral', status);
  }

  String get tone => _row.$1;
  String get labelKey => 'ui.status.$kind.$status';

  @override
  Widget build(BuildContext context) {
    final (t, text) = _row;
    return _chip(t, [
      Flexible(
        child: Text(text, style: TextStyle(color: limsTone(t).fg, fontSize: LimsTokens.fontSizeSmSize, fontWeight: FontWeight.w500)),
      ),
    ]);
  }
}

/// Result flag badge (04 §1.3 flag rows; same labels as web FlagBadge). Critical = icon + bold text, never colour-only.
class LimsFlagBadge extends StatelessWidget {
  const LimsFlagBadge({super.key, required this.flag, this.showNormal = false});

  final String flag;
  final bool showNormal;

  static const _flags = <String, (String, String)>{
    'N': ('neutral', 'Normal'),
    'L': ('danger', 'Low'),
    'H': ('danger', 'High'),
    'LL': ('critical', 'Critical low'),
    'HH': ('critical', 'Critical high'),
    'A': ('danger', 'Abnormal'),
  };

  @override
  Widget build(BuildContext context) {
    final row = _flags[flag];
    if (row == null || (flag == 'N' && !showNormal)) return const SizedBox.shrink();
    final (tone, text) = row;
    final critical = tone == 'critical';
    final fg = limsTone(tone).fg;
    return _chip(tone, [
      if (critical) Icon(Icons.priority_high, size: 14, color: fg),
      Flexible(
        child: Text(text,
            style: TextStyle(color: fg, fontSize: LimsTokens.fontSizeXsSize, fontWeight: critical ? FontWeight.w700 : FontWeight.w600)),
      ),
    ]);
  }
}
