// Contact dispatch (patient pack S48 "Contact us"). The number and name come from the centre's configuration; with none
// configured the screen says so instead of inventing one.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../ui/phlebo_kit.dart';

class DispatchContact {
  const DispatchContact({required this.name, this.phone});

  final String name;
  final String? phone;
}

class ContactScreen extends StatelessWidget {
  const ContactScreen({super.key, required this.contact, required this.onCall, required this.onReport});

  final DispatchContact? contact;
  final ValueChanged<String> onCall;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final phone = contact?.phone;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Contact dispatch',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          if (contact == null)
            const PhleboNotice(tone: 'warning', title: 'No dispatch contact on this phone', text: 'Connect to the internet and sync to download your centre\'s contact.')
          else
            LimsCard(
              child: Row(children: [
                const PhleboIconTile(Icons.support_agent),
                const SizedBox(width: LimsTokens.space3),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(contact!.name, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                    Text(phone ?? 'No phone number set', style: t.bodyMedium?.copyWith(color: LimsTokens.colorNeutral600)),
                  ]),
                ),
              ]),
            ),
          const SizedBox(height: LimsTokens.space3),
          const PhleboNotice(tone: 'info', text: 'Don\'t read patient names, test names or results out loud on a call. Give the visit number instead.'),
          const SizedBox(height: LimsTokens.space4),
          LimsButton(label: 'Call dispatch', icon: Icons.call_outlined, onPressed: phone == null ? null : () => onCall(phone)),
          const SizedBox(height: LimsTokens.space2),
          LimsButton(label: 'Report a problem instead', icon: Icons.flag_outlined, secondary: true, onPressed: onReport),
        ]),
      ),
    );
  }
}
