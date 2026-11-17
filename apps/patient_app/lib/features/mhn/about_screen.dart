// About us: Metro Labs blurb (company details still to be supplied by the lab) and the two certification rows.
import 'package:flutter/material.dart';

import 'mhn_theme.dart';

class MhnAboutScreen extends StatelessWidget {
  const MhnAboutScreen({super.key});

  @override
  Widget build(BuildContext context) => MhnPage(
        title: 'About us',
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            MhnCard(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Metro Labs', style: Mhn.t(18, w: FontWeight.w800)),
                const SizedBox(height: 8),
                Text('Diagnostic laboratory in Kathmandu. My Health Now is its app for booking tests, home sample collection and reports.', style: Mhn.body),
                const SizedBox(height: 10),
                Text('[Company history, founding year, number of centres and team, to be supplied by Metro Labs]', style: Mhn.body),
              ]),
            ),
            const SizedBox(height: 12),
            MhnCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                for (var i = 0; i < 2; i++)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                    decoration: BoxDecoration(border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null),
                    child: Row(children: [
                      const Icon(Icons.verified_user_outlined, size: 22, color: Mhn.green),
                      const SizedBox(width: 12),
                      Text(i == 0 ? 'ISO 9001:2015 certified' : 'Approved by NPHL', style: Mhn.t(15, w: FontWeight.w700)),
                    ]),
                  ),
              ]),
            ),
          ],
        ),
      );
}
