// A22 Enquiries list (04-UI-UX A22; 03-APP-FLOW §10.1; US-EN-18.3). One LimsListTile per enquiry in API order (newest first): subject + status word + icon; message text is never listed.
// States: skeleton, "No messages", error + Retry. PHI screen (LimsSecureScreen, REQ-SEC-109). LD-140: lims_ui widgets and tokens only; one primary button per page ([New message]).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import 'enquiries_providers.dart';
import 'enquiry_copy.dart';

class EnquiriesScreen extends ConsumerWidget {
  const EnquiriesScreen({super.key, this.onOpen, this.onNew});

  final void Function(String enquiryId)? onOpen;
  final VoidCallback? onNew;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(enquiriesProvider);
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Messages',
        body: Column(children: [
          Expanded(
            child: list.when(
              loading: () => const LimsLoading(),
              error: (_, __) => LimsErrorState(title: 'Could not load your messages', message: 'Check your connection and try again.', onRetry: () => ref.invalidate(enquiriesProvider)),
              data: (items) => items.isEmpty
                  ? const LimsEmptyState(title: 'No messages', message: 'Ask the lab a question and the reply will show here.', icon: Icons.chat_bubble_outline)
                  : RefreshIndicator(
                      onRefresh: () async {
                        ref.invalidate(enquiriesProvider);
                        try {
                          await ref.read(enquiriesProvider.future);
                        } catch (_) {
                          // the error state shows on the next build
                        }
                      },
                      child: ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        itemCount: items.length,
                        separatorBuilder: (_, __) => const Divider(height: LimsTokens.space0),
                        itemBuilder: (_, i) => LimsListTile(
                          leading: Icon(statusIcon(items[i].status)),
                          title: items[i].subject,
                          subtitle: whenText(items[i].lastMessageAt),
                          trailing: EnquiryStatusChip(items[i].status),
                          onTap: () => onOpen?.call(items[i].id),
                        ),
                      ),
                    ),
            ),
          ),
          Padding(padding: const EdgeInsets.all(LimsTokens.space4), child: SizedBox(width: double.infinity, child: LimsButton(label: 'New message', onPressed: onNew))),
        ]),
      ),
    );
  }
}
