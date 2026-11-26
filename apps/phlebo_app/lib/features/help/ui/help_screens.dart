// PHLEBO-UI-FULL-1 G05: help works offline. Each answer states what this app does (no centre policy is invented).
// Dispatch phone and problem reports have no contract and say so.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../../app/theme.dart';

const faqs = <(String, String)>[
  (
    'What if I have no signal?',
    'Keep working. Everything you record is saved on this phone and uploads when you are online again. The Outbox shows what is still waiting.'
  ),
  (
    'The scanned tube says it belongs to another patient.',
    "Don't use that tube. The app does not accept it. Scan only the tubes listed on this visit."
  ),
  ('Can I add a test at the door?', 'The app has no way to add a test. Collect only the tubes listed on the visit and ask the centre.'),
  (
    "The patient's name or phone does not match.",
    'Record the mismatch on the identity check. You cannot collect samples for that visit; the app takes you to "Can\'t do this visit".'
  ),
  ('The patient refuses or is not home.', 'Open the visit, tap "Can\'t do this visit" and choose the reason.'),
  (
    'I could only collect some of the tubes.',
    'Mark each missing tube "not collected" with a reason, then finish the visit. It is recorded as partly collected.'
  ),
  ('How do I hand tubes over?', 'Open Handover, choose the centre, tick the tubes and tap Hand over. Centre staff scan them to confirm.'),
  (
    'Why was my list cleared?',
    'For security the list is erased after the offline time limit, on a new day, or when your session ends. Connect to download it again. Unsent changes are kept.'
  ),
  ('Can I sign out with changes waiting?', 'No. Upload them first; sign-out stays off until nothing is waiting.'),
];

class HelpScreen extends StatelessWidget {
  const HelpScreen({super.key, required this.onFaqs, required this.onContact, required this.onReport});

  final VoidCallback onFaqs, onContact, onReport;

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Help & support',
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            const NoticeCard(tone: 'info', title: 'Stuck at a door?', text: 'Call your dispatch desk first.'),
            const SizedBox(height: LimsTokens.space3),
            LimsCard(
              child: Column(children: [
                MenuRow(icon: Icons.quiz_outlined, title: 'FAQs', subtitle: 'Answers that work offline', onTap: onFaqs),
                MenuRow(icon: Icons.headset_mic_outlined, title: 'Contact dispatch', subtitle: 'How to reach the centre', onTap: onContact),
                MenuRow(icon: Icons.flag_outlined, title: 'Report a problem', subtitle: 'Tell the centre what went wrong', onTap: onReport),
              ]),
            ),
          ]),
        ),
      );
}

class FaqScreen extends StatefulWidget {
  const FaqScreen({super.key});

  @override
  State<FaqScreen> createState() => _FaqScreenState();
}

class _FaqScreenState extends State<FaqScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final found = [for (final f in faqs) if (q.isEmpty || '${f.$1} ${f.$2}'.toLowerCase().contains(q)) f];
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'FAQs',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsTextField(label: 'Search FAQs', maxLength: 80, sensitive: true, onChanged: (v) => setState(() => _query = v)),
          if (found.isEmpty)
            const LimsEmptyState(title: 'No answers found', icon: Icons.search_off)
          else
            LimsCard(
              child: Column(children: [
                for (final f in found)
                  ExpansionTile(
                    key: ValueKey(f.$1),
                    title: Text(f.$1),
                    childrenPadding: const EdgeInsets.all(LimsTokens.space4),
                    expandedCrossAxisAlignment: CrossAxisAlignment.start,
                    children: [Text(f.$2)],
                  ),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// E / F / G05c / G05d: a titled page for something the design draws and the system cannot do yet.
class NotAvailableScreen extends StatelessWidget {
  const NotAvailableScreen({super.key, required this.title, required this.what, required this.instead, required this.icon});

  final String title, what, instead;
  final IconData icon;

  @override
  Widget build(BuildContext context) =>
      LimsSecureScreen(child: LimsScaffold(title: title, body: NotAvailable(what: what, instead: instead, icon: icon)));
}

const historyPage = NotAvailableScreen(
  title: 'History',
  what: 'Past working days are not kept in the app yet.',
  instead: 'The centre has the record of every visit.',
  icon: Icons.history,
);
const alertsPage = NotAvailableScreen(
  title: 'Alerts',
  what: 'Alerts are not available in the app yet.',
  instead: 'Pull down on Today to get changes from the centre, including new and cancelled visits.',
  icon: Icons.notifications_none,
);
const contactDispatchPage = NotAvailableScreen(
  title: 'Contact dispatch',
  what: "The centre's dispatch number is not in the app yet.",
  instead: 'Use the number your lab gave you. Give the visit number, not patient names, test names or results.',
  icon: Icons.headset_mic_outlined,
);
const reportProblemPage = NotAvailableScreen(
  title: 'Report a problem',
  what: 'Sending a report from the app is not available yet.',
  instead: 'Call your dispatch desk and give the visit number, not patient names.',
  icon: Icons.flag_outlined,
);
