// 04-UI-UX §8 LimsDialog / LimsConfirmDialog (with reason codes).
import 'package:flutter/material.dart';

typedef LimsReason = ({String code, String label});

abstract final class LimsDialog {
  static Future<T?> show<T>(BuildContext context, {required String title, required Widget content, List<Widget>? actions}) =>
      showDialog<T>(
        context: context,
        builder: (c) => AlertDialog(title: Text(title), content: SingleChildScrollView(child: content), actions: actions),
      );
}

abstract final class LimsConfirmDialog {
  /// Resolves to the chosen reason code, '' when confirmed without reasons, or null on Cancel/dismiss.
  /// With `requireReason`, Confirm stays disabled until a reason is picked.
  static Future<String?> show(
    BuildContext context, {
    required String title,
    required String message,
    List<LimsReason> reasons = const [],
    bool requireReason = false,
    String confirmLabel = 'Confirm',
    String cancelLabel = 'Cancel',
  }) {
    String? picked;
    return showDialog<String>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => AlertDialog(
          title: Text(title),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(message),
              for (final r in reasons)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  selected: picked == r.code,
                  leading: Icon(picked == r.code ? Icons.radio_button_checked : Icons.radio_button_unchecked),
                  title: Text(r.label),
                  onTap: () => set(() => picked = r.code),
                ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(c).pop(), child: Text(cancelLabel)),
            FilledButton(
              onPressed: requireReason && picked == null ? null : () => Navigator.of(c).pop(picked ?? ''),
              child: Text(confirmLabel),
            ),
          ],
        ),
      ),
    );
  }
}
