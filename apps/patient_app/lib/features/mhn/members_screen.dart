// Other members (family): empty state or list with edit; "Add a member".
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'member_form_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnMembersScreen extends ConsumerWidget {
  const MhnMembersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(mhnProvider.select((s) => s.members));
    return MhnPage(
      title: 'Other members',
      bottom: MhnButton(label: '+ Add a member', onPressed: () => mhnPush<void>(context, const MhnMemberFormScreen())),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (members.isEmpty)
            MhnCard(
              padding: const EdgeInsets.all(22),
              child: Column(children: [
                const MhnIconTile(Icons.person_add_alt_outlined, size: 60),
                const SizedBox(height: 14),
                Text('Oops! Looks like no other member is added', textAlign: TextAlign.center, style: Mhn.t(16, w: FontWeight.w800, h: 1.25)),
                const SizedBox(height: 6),
                Text('Add family members to book tests and keep their reports in one place.', textAlign: TextAlign.center, style: Mhn.body),
              ]),
            )
          else
            MhnCard(
              padding: EdgeInsets.zero,
              child: Column(children: [
                for (var i = 0; i < members.length; i++)
                  InkWell(
                    onTap: () => mhnPush<void>(context, MhnMemberFormScreen(editing: members[i])),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null),
                      child: Row(children: [
                        CircleAvatar(radius: 20, backgroundColor: Mhn.tint, child: Text(members[i].name[0].toUpperCase(), style: Mhn.t(16, w: FontWeight.w800, c: Mhn.green))),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(members[i].name, style: Mhn.t(15, w: FontWeight.w700)),
                            Text(
                              '${members[i].relation}${members[i].gender.isEmpty ? '' : ' · ${members[i].gender}'}${members[i].dob.isEmpty || ageFrom(members[i].dob) == null ? '' : ' · ${ageFrom(members[i].dob)} yrs'}',
                              style: Mhn.t(12, c: Mhn.muted),
                            ),
                          ]),
                        ),
                        const Icon(Icons.edit_outlined, size: 18, color: Mhn.muted),
                      ]),
                    ),
                  ),
              ]),
            ),
        ],
      ),
    );
  }
}
