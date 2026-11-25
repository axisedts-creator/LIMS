// Bundled help (works offline). Every answer restates a rule that is already in the C17 spec; no policy of its own.
class Faq {
  const Faq(this.question, this.answer);

  final String question;
  final String answer;
}

const phleboFaqs = <Faq>[
  Faq('What if I have no signal?', 'Keep working. Everything you record is saved on the phone and uploads by itself when you are back online. The Outbox shows what is waiting.'),
  Faq('The scanned tube says it belongs to another patient.', "Don't use it. Scan only the tubes labelled for this visit. If a tube is missing, mark it not collected and give the reason."),
  Faq('Can I add a test at the door?', 'No. Tubes are labelled at the centre before you leave, so tests cannot be added at the door. Ask dispatch to arrange a new visit.'),
  Faq("The patient's name or phone does not match.", "Don't collect. Choose \"Name doesn't match\" or \"doesn't match\" on the identity check, then fail the visit with the reason Identity mismatch."),
  Faq('The patient refuses or is not home.', 'Use "Can\'t do this visit" and pick the reason. Dispatch will reschedule.'),
  Faq('I could only collect some of the tubes.', 'Mark each missing tube as not collected with a reason, then finish the visit. The centre sees it as partly collected and can arrange a revisit.'),
  Faq('How do I hand tubes over?', 'Open Handover, choose the centre, and tick the tubes you are giving. Centre staff scan each tube to confirm.'),
  Faq('Why was my list cleared?', 'When the phone stays offline for longer than the centre allows, it erases the list for security. Connect to the internet to download it again.'),
  Faq('Can I sign out with changes waiting?', 'No. Sync first. Signing out erases the visit list from this phone.'),
];
