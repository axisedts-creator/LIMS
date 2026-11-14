// A5 app-bar bell (04-UI-UX §1.1): bell with the unread count of the first E45 page (unread_only=true), capped "9+". No badge at 0, while loading or on error
// (the bell must never break the home bar). Refreshes on mount and on resume only (US-EN-11.2, no push). LD-140: lims_ui / Material widgets and tokens only.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'notifications_providers.dart';

class NotificationBell extends ConsumerWidget {
  const NotificationBell({super.key, this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = ref.watch(unreadCountProvider).value ?? 0;
    return RefreshOnResume(
      onResume: () => ref.invalidate(unreadCountProvider),
      child: Semantics(
        button: true,
        label: n > 0 ? 'Notifications, $n unread' : 'Notifications',
        onTap: onPressed,
        excludeSemantics: true,
        child: IconButton(
          onPressed: onPressed,
          icon: Badge(label: Text(n > 9 ? '9+' : '$n'), isLabelVisible: n > 0, child: const Icon(Icons.notifications_outlined)),
        ),
      ),
    );
  }
}
