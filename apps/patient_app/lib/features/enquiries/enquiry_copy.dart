// A22 shared copy and small widgets (03-APP-FLOW §10.1 A22; US-EN-18.1-18.4). LD-140: lims_ui widgets and tokens only; a status always shows tone, icon and word.
import 'package:flutter/material.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

const closedNotice = 'This conversation is closed.';
const _limitNotice = 'You have too many open messages. Wait for a reply first.';
const _disabledNotice = 'Messages are turned off for now.';
const _genericNotice = 'We could not send your message. Try again.';

/// Plain-language text for a failed E49 / E51 (never the server text, never the typed text).
String sendFailure(Object e) {
  final code = e is LimsException ? e.code : null;
  return switch (code) {
    'engagement.enquiry_invalid_transition' => _limitNotice,
    'common.feature_disabled' => _disabledNotice,
    _ => _genericNotice,
  };
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "4 Nov 2026, 10:00" in the phone's local time; an unparsable value is shown as it came.
String whenText(String iso) {
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return iso;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.day} ${_months[t.month - 1]} ${t.year}, ${two(t.hour)}:${two(t.minute)}';
}

/// status -> (word, tone, icon).
(String, String, IconData) _look(String status) => switch (status) {
      'open' => ('Open', 'info', Icons.mark_chat_unread_outlined),
      'answered' => ('Answered', 'success', Icons.mark_chat_read_outlined),
      'closed' => ('Closed', 'neutral', Icons.lock_outline),
      _ => (status, 'neutral', Icons.chat_bubble_outline),
    };

IconData statusIcon(String status) => _look(status).$3;

class EnquiryStatusChip extends StatelessWidget {
  const EnquiryStatusChip(this.status, {super.key});

  final String status;

  @override
  Widget build(BuildContext context) {
    final (word, tone, _) = _look(status);
    return LimsStatusChip(kind: 'generic', status: status, label: word, tone: tone);
  }
}
