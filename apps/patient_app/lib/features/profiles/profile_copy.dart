// User-facing words shared by A6-A9 (03-APP-FLOW §10.1; done_when "copy and identical error text").
// Each sentence is defined once here. Error text is chosen from the error CODE only: server detail, the code the user typed and the
// pasted link are never shown (no oracle: unknown / expired / wrong phone / already redeemed all read the same).
import 'package:flutter/material.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

const genericError = 'Something went wrong. Try again.';
const _invalid = "This code didn't work. Check it or ask the lab for a new one.";
const _tooMany = 'Too many tries. Try again in an hour.';
const _limit = 'You have the maximum number of profiles.';

const relationshipLabels = <String, String>{
  'self': 'Me',
  'child': 'Child',
  'parent': 'Parent',
  'spouse': 'Spouse',
  'sibling': 'Sibling',
  'other': 'Other',
};

const methodText = <String, String>{
  'link_code': 'Linked with lab code',
  'report_link': 'Linked from a report message — earlier reports are not shown',
  'self_registered': 'Registered in the app',
};

/// A7, A8 and A9 failures. [validationIsInvalid]: A8 reads a server 400 as an invalid link (the client already checked the shape).
String linkFailureCopy(Object e, {bool validationIsInvalid = false}) {
  if (e is LimsException) {
    switch (e.code) {
      case LimsErrorCodes.engagementLinkCodeInvalid:
        return _invalid;
      case LimsErrorCodes.commonValidationFailed:
        if (validationIsInvalid) return _invalid;
      case LimsErrorCodes.commonRateLimited: // with or without a Retry-After: the sentence does not promise a time the server did not give
        return _tooMany;
      case LimsErrorCodes.engagementLinkLimitReached:
        return _limit;
    }
  }
  return genericError;
}

/// Icon + words in the danger tone (LD-140: a status is never colour alone). Announced to screen readers when it appears.
class ProfileNotice extends StatelessWidget {
  const ProfileNotice(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = limsTone('danger');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: LimsTokens.space2),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.error_outline, color: c.fg),
          const SizedBox(width: LimsTokens.space2),
          Expanded(child: Text(message, style: TextStyle(color: c.fg))),
        ]),
      ),
    );
  }
}
