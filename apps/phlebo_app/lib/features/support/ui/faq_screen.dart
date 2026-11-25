// FAQs with search (patient pack S49 / S49a "no results"). Filtering is local and case-insensitive.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../domain/faq_content.dart';

class FaqScreen extends StatefulWidget {
  const FaqScreen({super.key, this.faqs = phleboFaqs});

  final List<Faq> faqs;

  @override
  State<FaqScreen> createState() => _FaqScreenState();
}

class _FaqScreenState extends State<FaqScreen> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.trim().toLowerCase();
    final shown = q.isEmpty ? widget.faqs : widget.faqs.where((f) => f.question.toLowerCase().contains(q) || f.answer.toLowerCase().contains(q)).toList();
    final t = Theme.of(context).textTheme;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'FAQs',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          TextField(
            key: const ValueKey('faq.search'),
            onChanged: (v) => setState(() => _q = v),
            maxLength: 80,
            enableSuggestions: false,
            autocorrect: false,
            textInputAction: TextInputAction.search,
            decoration: const InputDecoration(labelText: 'Search FAQs', prefixIcon: Icon(Icons.search), counterText: ''),
          ),
          const SizedBox(height: LimsTokens.space3),
          if (shown.isEmpty)
            const LimsEmptyState(title: 'No answers found', message: 'Try fewer words, or contact dispatch.', icon: Icons.search_off)
          else
            Card(
              clipBehavior: Clip.antiAlias,
              margin: EdgeInsets.zero,
              child: Column(children: [
                for (var i = 0; i < shown.length; i++) ...[
                  if (i > 0) const Divider(),
                  Theme(
                    data: Theme.of(context).copyWith(dividerColor: LimsTokens.colorNeutral0),
                    child: ExpansionTile(
                      title: Text(shown[i].question, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                      childrenPadding: const EdgeInsets.fromLTRB(LimsTokens.space4, 0, LimsTokens.space4, LimsTokens.space4),
                      expandedCrossAxisAlignment: CrossAxisAlignment.start,
                      children: [Text(shown[i].answer, style: t.bodyMedium?.copyWith(color: LimsTokens.colorNeutral700))],
                    ),
                  ),
                ],
              ]),
            ),
        ]),
      ),
    );
  }
}
