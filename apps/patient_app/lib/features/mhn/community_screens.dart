// Community Screens (H04 Feed, H05 Discussion Forum, H06 Ask & Share Sheet)
// Features realistic avatar photos, top verified responses, discussions, expert advice, and interactive posting.
import 'package:flutter/material.dart';

import 'mhn_theme.dart';

class MhnCommunityPost {
  const MhnCommunityPost({
    required this.id,
    required this.author,
    required this.time,
    required this.text,
    required this.likes,
    required this.comments,
    required this.views,
    this.topResponder,
    this.topResponseTime,
    this.topResponseText,
    this.isExpert = false,
  });

  final String id;
  final String author;
  final String time;
  final String text;
  final int likes;
  final int comments;
  final int views;
  final String? topResponder;
  final String? topResponseTime;
  final String? topResponseText;
  final bool isExpert;
}

const kCommunityPosts = <MhnCommunityPost>[
  MhnCommunityPost(
    id: 'post_1',
    author: 'Sita K.',
    time: '1 week ago | Member',
    text: 'Sample post: my ankle has been swollen for days and walking hurts. Which test should I book?',
    likes: 2,
    comments: 2,
    views: 13,
    topResponder: 'Aarav P.',
    topResponseTime: '5 days ago - Member',
    topResponseText: 'Sample reply: thank you, noted.',
  ),
  MhnCommunityPost(
    id: 'post_2',
    author: 'Rohan T.',
    time: '1 week ago | Member',
    text: 'Sample post: advice on a cholesterol check, please.',
    likes: 1,
    comments: 1,
    views: 6,
    topResponder: 'Dr. Meera L.',
    topResponseTime: '1 week ago - Doctor',
    topResponseText: 'Sample reply: a lipid profile is a common first step.',
    isExpert: true,
  ),
  MhnCommunityPost(
    id: 'post_3',
    author: 'Nima S.',
    time: '2 weeks ago | Member',
    text: 'Sample post: fever for a week with body ache. Should I get a blood test done?',
    likes: 2,
    comments: 2,
    views: 12,
    topResponder: 'Dr. Meera L.',
    topResponseTime: '1 week ago - Doctor',
    topResponseText: 'Sample reply: share the temperature pattern and any cough.',
    isExpert: true,
  ),
  MhnCommunityPost(
    id: 'post_4',
    author: 'Suvan K.',
    time: '2 weeks ago | Member',
    text: 'Sample story: small daily habits made my check-ups easier.',
    likes: 4,
    comments: 2,
    views: 12,
  ),
  MhnCommunityPost(
    id: 'post_5',
    author: 'Shalini R.',
    time: '1 month ago | Member',
    text: 'Sample post: has anyone tried a morning walk routine for stress?',
    likes: 3,
    comments: 1,
    views: 9,
    topResponder: 'Sachin P.',
    topResponseTime: '2 weeks ago - Member',
    topResponseText: 'Sample reply: it helped me.',
  ),
];

class MhnCommunityScreen extends StatefulWidget {
  const MhnCommunityScreen({super.key, this.isTab = false});
  final bool isTab;

  @override
  State<MhnCommunityScreen> createState() => _MhnCommunityScreenState();
}

class _MhnCommunityScreenState extends State<MhnCommunityScreen> {
  int _activeFilter = 0;
  final _searchCtrl = TextEditingController();
  final _filters = const ['For you', 'Customer Stories', 'Ask an Expert', 'Discussion'];

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D3327), // Community dark forest background from wireframe
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(
                children: [
                  if (!widget.isTab)
                    InkWell(
                      onTap: () => Navigator.of(context).maybePop(),
                      borderRadius: BorderRadius.circular(20),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: const Color(0xFF1B4E3E),
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.chevron_left, color: Mhn.lime, size: 18),
                            Text('Main App', style: Mhn.t(12, w: FontWeight.w600, c: Mhn.lime)),
                          ],
                        ),
                      ),
                    ),
                  const Spacer(),
                  Text('Community', style: Mhn.t(18, w: FontWeight.w700, c: Mhn.white)),
                  const Spacer(),
                  const SizedBox(width: 40),
                ],
              ),
            ),
            // Search health topics
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Container(
                height: 44,
                decoration: BoxDecoration(
                  color: const Color(0xFF164032),
                  borderRadius: BorderRadius.circular(22),
                  border: Border.all(color: const Color(0xFF225745)),
                ),
                child: TextField(
                  controller: _searchCtrl,
                  style: Mhn.t(14, c: Mhn.white),
                  decoration: InputDecoration(
                    prefixIcon: const Icon(Icons.search, color: Color(0xFF88A89A), size: 20),
                    hintText: 'Search health topics',
                    hintStyle: Mhn.t(14, c: const Color(0xFF88A89A)),
                    border: InputBorder.none,
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                ),
              ),
            ),
            // Filter Pills
            SizedBox(
              height: 40,
              child: ListView.separated(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                scrollDirection: Axis.horizontal,
                itemCount: _filters.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) {
                  final active = _activeFilter == i;
                  return InkWell(
                    borderRadius: BorderRadius.circular(18),
                    onTap: () => setState(() => _activeFilter = i),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                      decoration: BoxDecoration(
                        color: active ? Mhn.lime : const Color(0xFF164032),
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: active ? Mhn.lime : const Color(0xFF2A5F4D)),
                      ),
                      child: Center(
                        child: Text(
                          _filters[i],
                          style: Mhn.t(12, w: FontWeight.w700, c: active ? Mhn.greenDeep : Mhn.white),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
            // Post List
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 80),
                children: [
                  for (final p in kCommunityPosts) _buildPostCard(p),
                  // Ask an Expert Section (H04)
                  _buildAskExpertSection(),
                  const SizedBox(height: 16),
                  _buildDiscussionBanner(),
                  const SizedBox(height: 16),
                  _buildVideosAndBlogsSection(),
                ],
              ),
            ),
          ],
        ),
      ),
      // Floating Share/Ask Action Button (H06)
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: Mhn.green,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(30),
          side: const BorderSide(color: Mhn.lime, width: 2),
        ),
        onPressed: () => _openAskShareSheet(context),
        icon: const Icon(Icons.add, color: Mhn.white),
        label: Text('Share/Ask', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.white)),
      ),
    );
  }

  Widget _buildPostCard(MhnCommunityPost p) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF133B2E),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFF1E5241)),
        boxShadow: const [
          BoxShadow(color: Color(0x22000000), blurRadius: 10, offset: Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              MhnAvatar(name: p.author, radius: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.author, style: Mhn.t(14, w: FontWeight.w700, c: Mhn.white)),
                    Text(p.time, style: Mhn.t(11, c: const Color(0xFF88A89A))),
                  ],
                ),
              ),
              IconButton(
                icon: const Icon(Icons.share_outlined, color: Color(0xFF88A89A), size: 18),
                onPressed: () => mhnToast(context, 'Link copied!'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            p.text,
            style: Mhn.t(14, c: const Color(0xFFD6E4DC), h: 1.4),
          ),
          if (p.topResponder != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0C2B20),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFF1B5542)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: const Color(0xFFD9EE8C),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.star, color: Color(0xFF0A3328), size: 12),
                            const SizedBox(width: 4),
                            Text('TOP RESPONSE', style: Mhn.t(9, w: FontWeight.w800, c: Color(0xFF0A3328))),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      const Icon(Icons.verified, color: Mhn.lime, size: 14),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      MhnAvatar(name: p.topResponder!, radius: 12),
                      const SizedBox(width: 8),
                      Text(p.topResponder!, style: Mhn.t(12, w: FontWeight.w700, c: Mhn.white)),
                      const SizedBox(width: 6),
                      Text(p.topResponseTime ?? '', style: Mhn.t(10, c: const Color(0xFF88A89A))),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(p.topResponseText ?? '', style: Mhn.t(13, c: const Color(0xFFD6E4DC))),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      const Icon(Icons.check, color: Mhn.lime, size: 14),
                      const SizedBox(width: 4),
                      Text('Helpful', style: Mhn.t(11, w: FontWeight.w600, c: Mhn.lime)),
                    ],
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 4,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.favorite_border, color: Color(0xFF88A89A), size: 16),
                  const SizedBox(width: 4),
                  Text('${p.likes} Likes', style: Mhn.t(12, c: const Color(0xFF88A89A))),
                ],
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.chat_bubble_outline, color: Color(0xFF88A89A), size: 16),
                  const SizedBox(width: 4),
                  Text('${p.comments} Comments', style: Mhn.t(12, c: const Color(0xFF88A89A))),
                ],
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.visibility_outlined, color: Color(0xFF88A89A), size: 16),
                  const SizedBox(width: 4),
                  Text('${p.views} views', style: Mhn.t(12, c: const Color(0xFF88A89A))),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildAskExpertSection() {
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF133B2E),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFF1E5241)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Ask an Expert', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.white)),
              const Spacer(),
              Text('See all >', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.lime)),
            ],
          ),
          const SizedBox(height: 4),
          Text('Your health questions, answered by professionals', style: Mhn.t(12, c: const Color(0xFF88A89A))),
          const SizedBox(height: 14),
          Row(
            children: [
              Text('Asked by: MEMBER', style: Mhn.t(11, c: const Color(0xFF88A89A))),
              const Spacer(),
              Text('22 Nov 2026', style: Mhn.t(11, c: const Color(0xFF88A89A))),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Sample question: I have been losing more hair than usual for a few weeks. What could be the cause?',
            style: Mhn.t(13, w: FontWeight.w600, c: Mhn.white),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              const MhnAvatar(name: 'Doctor', radius: 14),
              const SizedBox(width: 8),
              Text('Doctor name', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.white)),
              const SizedBox(width: 4),
              const Icon(Icons.verified, color: Mhn.lime, size: 14),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'Sample reply: several nutritional and hormonal causes are possible; a blood test can help narrow it down.',
            style: Mhn.t(12, c: const Color(0xFFD6E4DC)),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: const Color(0xFF0C2B20),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    style: Mhn.t(13, c: Mhn.white),
                    decoration: InputDecoration(
                      hintText: 'Type message...',
                      hintStyle: Mhn.t(13, c: const Color(0xFF88A89A)),
                      border: InputBorder.none,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_forward, color: Mhn.lime, size: 18),
                  onPressed: () => mhnToast(context, 'Question sent to doctor!'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDiscussionBanner() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF165C4A),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Feeling inspired?', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.white)),
                const SizedBox(height: 4),
                Text('Share your own story and motivate someone else to start.', style: Mhn.t(12, c: Colors.white70)),
              ],
            ),
          ),
          const SizedBox(width: 12),
          InkWell(
            onTap: () => _openAskShareSheet(context),
            child: const CircleAvatar(
              backgroundColor: Mhn.white,
              radius: 18,
              child: Icon(Icons.chevron_right, color: Mhn.green),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildVideosAndBlogsSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Health Videos', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.white)),
            const Spacer(),
            Text('Explore more >', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.lime)),
          ],
        ),
        const SizedBox(height: 4),
        Text('Watch. Learn. Improve.', style: Mhn.t(12, c: const Color(0xFF88A89A))),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: _videoCard('Sample video title')),
            const SizedBox(width: 12),
            Expanded(child: _videoCard('Sample video title')),
          ],
        ),
      ],
    );
  }

  Widget _videoCard(String title) {
    return Container(
      height: 100,
      decoration: BoxDecoration(
        color: const Color(0xFF133B2E),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF1E5241)),
      ),
      child: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.play_circle_fill, color: Mhn.lime, size: 36),
            const SizedBox(height: 6),
            Text(title, style: Mhn.t(11, w: FontWeight.w600, c: Mhn.white)),
            Text('MetroLabs content', style: Mhn.t(9, c: const Color(0xFF88A89A))),
          ],
        ),
      ),
    );
  }

  void _openAskShareSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const _MhnAskShareSheet(),
    );
  }
}

/// H06: Community Ask & Share Sheet
class _MhnAskShareSheet extends StatefulWidget {
  const _MhnAskShareSheet();

  @override
  State<_MhnAskShareSheet> createState() => _MhnAskShareSheetState();
}

class _MhnAskShareSheetState extends State<_MhnAskShareSheet> {
  int _activeTab = 0; // 0: Share Experience, 1: Ask Question
  bool _startAsDiscussion = false;
  final _contentCtrl = TextEditingController();

  @override
  void dispose() {
    _contentCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(20, 16, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      decoration: const BoxDecoration(
        color: Mhn.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFFDCE8E0),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Text('Ask & Share with Community', style: Mhn.t(18, w: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('Get verified advice from top experts', style: Mhn.t(13, c: Mhn.muted)),
            const SizedBox(height: 16),
            // Toggle Tab Bar
            Row(
              children: [
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _activeTab = 0),
                    child: Column(
                      children: [
                        Text('Share Experience', style: Mhn.t(14, w: FontWeight.w700, c: _activeTab == 0 ? Mhn.green : Mhn.mutedSoft)),
                        const SizedBox(height: 6),
                        Container(height: 2, color: _activeTab == 0 ? Mhn.green : Colors.transparent),
                      ],
                    ),
                  ),
                ),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _activeTab = 1),
                    child: Column(
                      children: [
                        Text('Ask Question', style: Mhn.t(14, w: FontWeight.w700, c: _activeTab == 1 ? Mhn.green : Mhn.mutedSoft)),
                        const SizedBox(height: 6),
                        Container(height: 2, color: _activeTab == 1 ? Mhn.green : Colors.transparent),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            Text(
              _activeTab == 0
                  ? 'Share your wins, stories and ideas - this is your space to shine. *'
                  : 'Ask your health question - verified doctors and members answer. *',
              style: Mhn.t(13, w: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Container(
              height: 120,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                border: Border.all(color: Mhn.line),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Column(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _contentCtrl,
                      maxLines: null,
                      style: Mhn.t(14),
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        hintText: _activeTab == 0
                            ? 'Describe your thoughts/experience in detail'
                            : 'State your symptom, concern or question in detail',
                        hintStyle: Mhn.t(14, c: Mhn.mutedSoft),
                      ),
                    ),
                  ),
                  Align(
                    alignment: Alignment.bottomRight,
                    child: Text('Up to 200 words', style: Mhn.t(11, c: Mhn.mutedSoft)),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            Text('Example: feeling tired even after 8 hours of sleep', style: Mhn.t(12, c: Mhn.mutedSoft)),
            const SizedBox(height: 16),
            Text('Upload images (optional, max 3)', style: Mhn.t(13, w: FontWeight.w600)),
            Text('Images up to 10 MB', style: Mhn.t(11, c: Mhn.mutedSoft)),
            const SizedBox(height: 8),
            Row(
              children: [
                _photoUploadSlot('Add photo', Icons.camera_alt_outlined),
                const SizedBox(width: 10),
                _emptyPhotoSlot(),
                const SizedBox(width: 10),
                _emptyPhotoSlot(),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Checkbox(
                  value: _startAsDiscussion,
                  activeColor: Mhn.green,
                  onChanged: (v) => setState(() => _startAsDiscussion = v ?? false),
                ),
                Text('Start as Discussion', style: Mhn.t(13, w: FontWeight.w600)),
              ],
            ),
            const SizedBox(height: 16),
            MhnButton(
              label: 'Post to community',
              onPressed: () {
                if (_contentCtrl.text.isEmpty) {
                  mhnToast(context, 'Please enter your thoughts before posting');
                  return;
                }
                Navigator.of(context).pop();
                mhnToast(context, 'Post shared to community!');
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _photoUploadSlot(String label, IconData icon) => Container(
        width: 80,
        height: 80,
        decoration: BoxDecoration(
          color: const Color(0xFFF2F7F4),
          border: Border.all(color: Mhn.green, style: BorderStyle.solid),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: Mhn.green, size: 24),
            const SizedBox(height: 4),
            Text(label, style: Mhn.t(10, w: FontWeight.w600, c: Mhn.green)),
          ],
        ),
      );

  Widget _emptyPhotoSlot() => Container(
        width: 80,
        height: 80,
        decoration: BoxDecoration(
          color: const Color(0xFFF2F7F4),
          borderRadius: BorderRadius.circular(12),
        ),
      );
}
