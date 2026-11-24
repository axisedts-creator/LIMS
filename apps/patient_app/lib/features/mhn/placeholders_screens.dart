// Healthians v1.1 auxiliary and placeholder screens (H09–H16)
// Notifications, Cart Empty, Splash, Heartbeat Loading, Wallet, Refer & Earn, Lucky Draw, Corporate Verification, Make Your Own Package.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'cart_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

/// H09: Notifications Screen
class MhnNotificationsScreen extends ConsumerWidget {
  const MhnNotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MhnPage(
      title: 'Notifications',
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Hi, Aarav', style: Mhn.t(18, w: FontWeight.w700)),
          const SizedBox(height: 6),
          Text('Recommended for you', style: Mhn.t(14, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 12),
          // Recommended Package Card
          MhnCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 120,
                  decoration: BoxDecoration(
                    color: const Color(0xFFE8F4EC),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Center(
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.water_drop, color: Color(0xFFC24141), size: 32),
                        const SizedBox(width: 8),
                        const Icon(Icons.analytics_outlined, color: Mhn.green, size: 48),
                        const SizedBox(width: 8),
                        const Icon(Icons.science_outlined, color: Color(0xFF9DBE2E), size: 32),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        'Sample health checkup package',
                        style: Mhn.t(16, w: FontWeight.w700),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFE5F1EB),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Column(
                        children: [
                          Text('86', style: Mhn.t(16, w: FontWeight.w800, c: Mhn.green)),
                          Text('TEST(S)', style: Mhn.t(10, w: FontWeight.w700, c: Mhn.mutedSoft)),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Text('Rs. - ', style: Mhn.t(18, w: FontWeight.w700, c: Mhn.ink)),
                    Text('Save Rs. - (placeholder)', style: Mhn.t(12, c: Mhn.mutedSoft)),
                  ],
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFC24141),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text('Upto -% OFF', style: Mhn.t(11, w: FontWeight.w700, c: Mhn.white)),
                    ),
                    const Spacer(),
                    SizedBox(
                      width: 130,
                      height: 40,
                      child: MhnButton(
                        label: 'Book Now',
                        onPressed: () {
                          mhnToast(context, 'Package added to cart');
                        },
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          // H14 Lucky Draw Card preview
          MhnCard(
            color: const Color(0xFF165C4A),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white24,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text('LUCKY DRAW', style: Mhn.t(10, w: FontWeight.w700, c: Mhn.white)),
                      ),
                      const SizedBox(height: 8),
                      Text('Win a wallet reward', style: Mhn.t(16, w: FontWeight.w700, c: Mhn.white)),
                      const SizedBox(height: 4),
                      Text('Reward details: MetroLabs to confirm', style: Mhn.t(12, c: Colors.white70)),
                      const SizedBox(height: 12),
                      SizedBox(
                        height: 36,
                        child: ElevatedButton(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF0A3328),
                            foregroundColor: Mhn.white,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                          onPressed: () => mhnPush<void>(context, const MhnLuckyDrawScreen()),
                          child: Text('Participate in lucky draw', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.white)),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Container(
                  width: 60,
                  height: 60,
                  decoration: const BoxDecoration(
                    color: Colors.white12,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.card_giftcard, color: Mhn.lime, size: 32),
                ),
              ],
            ),
          ),
          const SizedBox(height: 32),
          // Talk to health advisor bottom strip
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              gradient: Mhn.btnGradient,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Talk to our health advisor',
                    style: Mhn.t(14, w: FontWeight.w700, c: Mhn.white),
                  ),
                ),
                ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Mhn.lime,
                    foregroundColor: Mhn.green,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  onPressed: () => mhnToast(context, 'Connecting to health advisor...'),
                  icon: const Icon(Icons.call, size: 16),
                  label: Text('Call Now', style: Mhn.t(13, w: FontWeight.w700, c: Mhn.green)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// H10: My Cart Empty Screen
class MhnEmptyCartScreen extends StatelessWidget {
  const MhnEmptyCartScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'My Cart',
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 100,
                height: 100,
                decoration: const BoxDecoration(
                  color: Color(0xFFE5EDE8),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.shopping_cart_outlined, size: 48, color: Mhn.green),
              ),
              const SizedBox(height: 20),
              Text('Empty Health Cart', style: Mhn.t(20, w: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(
                "Looks like you haven't selected any test yet.",
                textAlign: TextAlign.center,
                style: Mhn.t(14, c: Mhn.muted),
              ),
              const SizedBox(height: 28),
              MhnButton(
                label: 'Book Test Now',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// H11: Launch Screen & H11b: Loading Screen (matches Healthians screen recording video & wireframe page 22)
class MhnSplashScreen extends StatefulWidget {
  const MhnSplashScreen({
    super.key,
    this.isLoadingMode = false,
    this.onComplete,
    this.onTransitionStart,
  });
  final bool isLoadingMode;
  final VoidCallback? onComplete;
  final VoidCallback? onTransitionStart;

  @override
  State<MhnSplashScreen> createState() => _MhnSplashScreenState();
}

class _MhnSplashScreenState extends State<MhnSplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;

  // Exact staged launch animation matching Screen_Recording_20261122_102812_Healthians.mp4:
  // Phase 1 (0.00 -> 0.20): Centered logo breathing pulse
  late Animation<double> _logoScaleAnim;

  // Phase 2 (0.20 -> 0.44): Logo glides smoothly up from center to top third
  late Animation<Alignment> _logoPosAnim;

  // Phase 2 (0.24 -> 0.46): Brand title and tagline fade & slide in
  late Animation<double> _titleFadeAnim;
  late Animation<Offset> _titleSlideAnim;
  late Animation<double> _taglineFadeAnim;

  // Phase 2 (0.20 -> 0.48): Phlebotomist and family photo slides up to the bottom edge
  late Animation<Offset> _peopleSlideAnim;
  late Animation<double> _peopleFadeAnim;

  // Heartbeat wave animation during steady state
  late Animation<double> _heartbeatProgress;

  bool _transitionTriggered = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    precacheImage(const AssetImage('assets/images/launch_people.jpg'), context);
    precacheImage(const AssetImage('assets/brand/ml-logo-white.png'), context);
    precacheImage(const AssetImage('assets/images/myhealth_logo_white.png'), context);
  }

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3600),
    );

    // 1. Center logo breathing pulse (starts 1.0 matching Android native splash)
    _logoScaleAnim = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween<double>(begin: 1.0, end: 1.08)
            .chain(CurveTween(curve: Curves.easeOutCubic)),
        weight: 45,
      ),
      TweenSequenceItem(
        tween: Tween<double>(begin: 1.08, end: 1.0)
            .chain(CurveTween(curve: Curves.easeInOut)),
        weight: 55,
      ),
    ]).animate(CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.00, 0.18, curve: Curves.linear),
    ));

    // 2. Logo glides up smoothly from center (matching native splash position)
    _logoPosAnim = AlignmentTween(
      begin: Alignment.center,
      end: const Alignment(0.0, -0.62),
    ).animate(CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.12, 0.42, curve: Curves.easeInOutCubic),
    ));

    // 3. Title typography fades and slides in
    _titleFadeAnim = CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.20, 0.42, curve: Curves.easeIn),
    );
    _titleSlideAnim = Tween<Offset>(
      begin: const Offset(0.0, 0.20),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.20, 0.42, curve: Curves.easeOutCubic),
    ));

    // 4. Subtitle tagline fades in
    _taglineFadeAnim = CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.28, 0.48, curve: Curves.easeIn),
    );

    // 5. Real people photo slides up from bottom edge
    _peopleSlideAnim = Tween<Offset>(
      begin: const Offset(0.0, 0.70),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.16, 0.46, curve: Curves.easeOutCubic),
    ));
    _peopleFadeAnim = CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.16, 0.36, curve: Curves.easeIn),
    );

    // Continuous heartbeat wave loop
    _heartbeatProgress = CurvedAnimation(
      parent: _ctrl,
      curve: const Interval(0.38, 1.00, curve: Curves.linear),
    );

    _ctrl.addStatusListener((status) {
      if (status == AnimationStatus.completed) {
        _triggerExit();
      }
    });

    _ctrl.forward();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _triggerExit() {
    if (_transitionTriggered) return;
    _transitionTriggered = true;
    if (widget.onTransitionStart != null) {
      widget.onTransitionStart!();
    } else if (widget.onComplete != null) {
      widget.onComplete!();
    } else {
      Navigator.of(context).maybePop();
    }
  }

  void _skip() {
    _ctrl.stop();
    _triggerExit();
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    return Scaffold(
      body: Container(
        width: double.infinity,
        height: double.infinity,
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              Color(0xFF00897B), // Deep vibrant brand teal
              Color(0xFF00A896), // Healthians video match teal
              Color(0xFF02B5A2),
            ],
            stops: [0.0, 0.45, 1.0],
          ),
        ),
        child: SafeArea(
          bottom: false,
          child: widget.isLoadingMode
              ? Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Spacer(),
                    AnimatedBuilder(
                      animation: _ctrl,
                      builder: (_, __) => CustomPaint(
                        size: const Size(200, 60),
                        painter: _HeartbeatPainter(_ctrl.value),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text('Loading', style: Mhn.t(16, w: FontWeight.w600, c: Mhn.white)),
                    const Spacer(),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 24),
                      child: TextButton(
                        onPressed: _skip,
                        child: Text('Close Preview', style: Mhn.t(13, c: Colors.white70)),
                      ),
                    ),
                  ],
                )
              : Stack(
                  alignment: Alignment.center,
                  children: [
                    // 1. Phlebotomist + Patient + Family photo (slides UP to fill bottom half of screen)
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: RepaintBoundary(
                        child: SlideTransition(
                          position: _peopleSlideAnim,
                          child: FadeTransition(
                            opacity: _peopleFadeAnim,
                            child: Stack(
                              alignment: Alignment.topCenter,
                              children: [
                                ClipRRect(
                                  borderRadius: const BorderRadius.vertical(
                                    top: Radius.circular(32),
                                  ),
                                  child: Image.asset(
                                    'assets/images/launch_people.jpg',
                                    width: double.infinity,
                                    height: media.size.height * 0.50,
                                    fit: BoxFit.cover,
                                    alignment: Alignment.topCenter,
                                    errorBuilder: (_, __, ___) => const SizedBox(height: 300),
                                  ),
                                ),
                                // Gradient fade overlay blending seamlessly into the teal background
                                Container(
                                  height: 90,
                                  decoration: const BoxDecoration(
                                    borderRadius: BorderRadius.vertical(
                                      top: Radius.circular(32),
                                    ),
                                    gradient: LinearGradient(
                                      begin: Alignment.topCenter,
                                      end: Alignment.bottomCenter,
                                      colors: [
                                        Color(0xFF00A896),
                                        Colors.transparent,
                                      ],
                                    ),
                                  ),
                                ),
                                // Floating Quality & Service Badge on the photo
                                Positioned(
                                  bottom: 24,
                                  left: 20,
                                  right: 20,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                                    decoration: BoxDecoration(
                                      color: const Color(0xC0000000),
                                      borderRadius: BorderRadius.circular(16),
                                      border: Border.all(color: Colors.white24),
                                    ),
                                    child: Row(
                                      children: [
                                        const Icon(Icons.verified, color: Color(0xFFD9EE8C), size: 20),
                                        const SizedBox(width: 8),
                                        Expanded(
                                          child: Text(
                                            'Nepal’s Smartest Diagnostics at Your Doorstep',
                                            style: Mhn.t(12, w: FontWeight.w600, c: Colors.white),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),

                    // 2. Animated White Logo + Brand typography
                    RepaintBoundary(
                      child: AnimatedBuilder(
                        animation: _ctrl,
                        builder: (context, _) {
                        return Align(
                          alignment: _logoPosAnim.value,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              // White vector stencil logo with breathing scale
                              Transform.scale(
                                scale: _logoScaleAnim.value,
                                child: Image.asset(
                                  'assets/brand/ml-logo-white.png',
                                  width: 125,
                                  height: 125,
                                  fit: BoxFit.contain,
                                  errorBuilder: (_, __, ___) =>
                                      const Icon(Icons.biotech, size: 96, color: Colors.white),
                                ),
                              ),
                              const SizedBox(height: 14),

                              // Title typography fading in
                              FadeTransition(
                                opacity: _titleFadeAnim,
                                child: SlideTransition(
                                  position: _titleSlideAnim,
                                  child: Column(
                                    children: [
                                      Text(
                                        'MetroLabs  |  Code Peak Nepal',
                                        style: Mhn.t(12, w: FontWeight.w600, c: Colors.white70),
                                      ),
                                      const SizedBox(height: 6),
                                      Image.asset(
                                        'assets/images/myhealth_logo_white.png',
                                        height: 34,
                                        fit: BoxFit.contain,
                                        errorBuilder: (_, __, ___) => Text(
                                          'my health now',
                                          style: Mhn.t(26, w: FontWeight.w800, c: Colors.white),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),

                              const SizedBox(height: 8),

                              // Tagline text fading in
                              FadeTransition(
                                opacity: _taglineFadeAnim,
                                child: Text(
                                  'Nepal’s Trusted Diagnostics Service Provider',
                                  style: Mhn.t(13, w: FontWeight.w600, c: const Color(0xFFD9EE8C)),
                                ),
                              ),

                              const SizedBox(height: 12),

                              // Glowing Heartbeat waveform
                              FadeTransition(
                                opacity: _taglineFadeAnim,
                                child: CustomPaint(
                                  size: const Size(180, 36),
                                  painter: _HeartbeatPainter((_heartbeatProgress.value * 4) % 1.0),
                                ),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                  ),

                    // 3. Skip Button (Top Right)
                    Positioned(
                      top: 12,
                      right: 16,
                      child: Material(
                        color: const Color(0x33FFFFFF),
                        borderRadius: BorderRadius.circular(16),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(16),
                          onTap: _skip,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text('Skip', style: Mhn.t(12, w: FontWeight.w700, c: Colors.white)),
                                const SizedBox(width: 4),
                                const Icon(Icons.arrow_forward_ios, size: 11, color: Colors.white),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _HeartbeatPainter extends CustomPainter {
  _HeartbeatPainter(this.progress);
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final path = Path();
    final w = size.width;
    final h = size.height;
    path.moveTo(0, h * 0.5);
    path.lineTo(w * 0.35, h * 0.5);
    path.lineTo(w * 0.42, h * 0.2);
    path.lineTo(w * 0.50, h * 0.85);
    path.lineTo(w * 0.58, h * 0.35);
    path.lineTo(w * 0.65, h * 0.5);
    path.lineTo(w, h * 0.5);
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_HeartbeatPainter old) => old.progress != progress;
}

/// H12: My Wallet Screen
class MhnWalletScreen extends StatelessWidget {
  const MhnWalletScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'My Wallet',
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: Mhn.btnGradient,
              borderRadius: BorderRadius.circular(18),
              boxShadow: const [
                BoxShadow(color: Color(0x180E4B3B), blurRadius: 16, offset: Offset(0, 6)),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Wallet balance', style: Mhn.t(13, c: Colors.white70)),
                const SizedBox(height: 6),
                Text('Rs. -', style: Mhn.t(28, w: FontWeight.w700, c: Mhn.white)),
                const SizedBox(height: 12),
                Text('Amounts and rules: MetroLabs to confirm', style: Mhn.t(12, c: Colors.white70)),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _walletRow(Icons.local_offer_outlined, 'Promo', 'Offer codes you can apply', () => mhnToast(context, 'Promo codes')),
          _walletRow(Icons.account_balance_wallet_outlined, 'Wallet cash', 'Credit you can use on bookings', () => mhnToast(context, 'Wallet cash')),
          _walletRow(Icons.star_outline, 'Flyer cash', 'Rewards from campaigns', () => mhnToast(context, 'Flyer cash')),
          const SizedBox(height: 16),
          _sampleDataNote('Placeholder. Healthians wallet screens were not in the recording; awaiting the second recording.'),
        ],
      ),
    );
  }

  Widget _walletRow(IconData icon, String title, String sub, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: MhnCard(
          padding: EdgeInsets.zero,
          child: ListTile(
            leading: MhnIconTile(icon),
            title: Text(title, style: Mhn.t(15, w: FontWeight.w700)),
            subtitle: Text(sub, style: Mhn.t(12, c: Mhn.muted)),
            trailing: const Icon(Icons.chevron_right, color: Mhn.mutedSoft),
            onTap: onTap,
          ),
        ),
      );
}

/// H13: Refer and Earn Screen
class MhnReferEarnScreen extends StatelessWidget {
  const MhnReferEarnScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'Refer and Earn',
      bottom: MhnButton(
        label: 'Share invite',
        onPressed: () => mhnToast(context, 'Invite link copied to clipboard!'),
      ),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: Mhn.btnGradient,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Refer a friend', style: Mhn.t(18, w: FontWeight.w700, c: Mhn.white)),
                      const SizedBox(height: 6),
                      Text('Reward details from MetroLabs', style: Mhn.t(13, c: Colors.white70)),
                    ],
                  ),
                ),
                Container(
                  width: 56,
                  height: 56,
                  decoration: const BoxDecoration(color: Colors.white12, shape: BoxShape.circle),
                  child: const Icon(Icons.card_giftcard, color: Mhn.lime, size: 30),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text('How it works', style: Mhn.t(16, w: FontWeight.w700)),
          const SizedBox(height: 14),
          _stepRow(1, 'Share your invite', 'Send your code to a friend'),
          _stepRow(2, 'Friend books a test', 'They book with MetroLabs'),
          _stepRow(3, 'Rewards', 'Reward details: MetroLabs to confirm'),
          const SizedBox(height: 20),
          _sampleDataNote('Placeholder. Reward text is MetroLabs to supply.'),
        ],
      ),
    );
  }

  Widget _stepRow(int num, String title, String sub) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 14,
              backgroundColor: const Color(0xFFE5EDE8),
              child: Text('$num', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.green)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Mhn.t(14, w: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text(sub, style: Mhn.t(13, c: Mhn.muted)),
                ],
              ),
            ),
          ],
        ),
      );
}

/// H14: Lucky Draw Screen
class MhnLuckyDrawScreen extends StatelessWidget {
  const MhnLuckyDrawScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'Lucky Draw',
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: Mhn.btnGradient,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(6)),
                  child: Text('LUCKY DRAW', style: Mhn.t(10, w: FontWeight.w700, c: Mhn.white)),
                ),
                const SizedBox(height: 10),
                Text('Win a wallet reward', style: Mhn.t(20, w: FontWeight.w700, c: Mhn.white)),
                const SizedBox(height: 6),
                Text('Reward details: MetroLabs to confirm', style: Mhn.t(13, c: Colors.white70)),
                const SizedBox(height: 18),
                SizedBox(
                  height: 44,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF0A3328),
                      foregroundColor: Mhn.white,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    onPressed: () => mhnToast(context, 'You are entered in the lucky draw!'),
                    child: Text('Participate in lucky draw', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.white)),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFFF7E6),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: const Color(0xFFFFD591)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.warning_amber_rounded, color: Color(0xFFD46B08), size: 22),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Check the rules first', style: Mhn.t(14, w: FontWeight.w700, c: const Color(0xFFD46B08))),
                      const SizedBox(height: 4),
                      Text(
                        'A lucky draw may fall under lottery or gaming rules in Nepal. MetroLabs needs to confirm before this is built.',
                        style: Mhn.t(12, c: Mhn.ink),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          _sampleDataNote('Placeholder. Not in the recording beyond the card on Notifications.'),
        ],
      ),
    );
  }
}

/// H15: Corporate Verification Screen
class MhnCorporateScreen extends StatefulWidget {
  const MhnCorporateScreen({super.key});

  @override
  State<MhnCorporateScreen> createState() => _MhnCorporateScreenState();
}

class _MhnCorporateScreenState extends State<MhnCorporateScreen> {
  final _email = TextEditingController();
  final _company = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _company.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'Corporate Verification',
      bottom: MhnButton(
        label: 'Verify',
        onPressed: () {
          if (_email.text.isEmpty || _company.text.isEmpty) {
            mhnToast(context, 'Please enter company name and work email');
            return;
          }
          mhnToast(context, 'Verification request submitted!');
          Navigator.of(context).maybePop();
        },
      ),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Verify and get exclusive benefits (MetroLabs to confirm).', style: Mhn.t(14, c: Mhn.muted)),
          const SizedBox(height: 20),
          MhnField(label: 'Work email', controller: _email, hint: 'name@company.com'),
          const SizedBox(height: 16),
          MhnField(label: 'Company name', controller: _company, hint: 'Company'),
          const SizedBox(height: 20),
          _sampleDataNote('Placeholder. MetroLabs decides whether corporate benefits exist.'),
        ],
      ),
    );
  }
}

/// H16: Make Your Own Package Screen
class MhnMakePackageScreen extends ConsumerStatefulWidget {
  const MhnMakePackageScreen({super.key});

  @override
  ConsumerState<MhnMakePackageScreen> createState() => _MhnMakePackageScreenState();
}

class _MhnMakePackageScreenState extends ConsumerState<MhnMakePackageScreen> {
  final _search = TextEditingController();
  final _selected = <String>['cbc', 'lipid', 'tft'];

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final available = kTests.where((t) => !_selected.contains(t.id)).toList();
    final totalPrice = _selected.fold<int>(0, (sum, id) => sum + (kTests.where((t) => t.id == id).firstOrNull?.price ?? 0));

    return MhnPage(
      title: 'Make Your Own Package',
      bottom: MhnButton(
        label: 'Review package (${rs(totalPrice)})',
        onPressed: _selected.isEmpty
            ? null
            : () {
                for (final id in _selected) {
                  if (!ref.read(mhnProvider).cart.contains(id)) {
                    ref.read(mhnProvider.notifier).toggleCart(id);
                  }
                }
                mhnToast(context, 'Custom package created with ${_selected.length} tests!');
                mhnPush<void>(context, const MhnCartScreen());
              },
      ),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _search,
            decoration: InputDecoration(
              hintText: 'Search tests to add',
              prefixIcon: const Icon(Icons.search, color: Mhn.green),
              filled: true,
              fillColor: Mhn.white,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: Mhn.line)),
              enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: Mhn.line)),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 20),
          Text('Selected tests', style: Mhn.t(16, w: FontWeight.w700)),
          const SizedBox(height: 12),
          for (final id in _selected)
            _selectedTestRow(kTests.firstWhere((t) => t.id == id, orElse: () => kTests.first)),
          const SizedBox(height: 16),
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => _openAddTestsSheet(available),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 14),
              decoration: BoxDecoration(
                border: Border.all(color: Mhn.green, style: BorderStyle.solid),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.add, color: Mhn.green, size: 20),
                  const SizedBox(width: 8),
                  Text('Add more tests', style: Mhn.t(14, w: FontWeight.w700, c: Mhn.green)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          _sampleDataNote('Placeholder. The builder was not in the recording; test list and total are samples.'),
        ],
      ),
    );
  }

  Widget _selectedTestRow(MhnTest t) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: MhnCard(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(t.name, style: Mhn.t(14, w: FontWeight.w600)),
                    Text(rs(t.price), style: Mhn.t(12, c: Mhn.mutedSoft)),
                  ],
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 18, color: Mhn.mutedSoft),
                onPressed: () => setState(() => _selected.remove(t.id)),
              ),
            ],
          ),
        ),
      );

  void _openAddTestsSheet(List<MhnTest> available) {
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => StatefulBuilder(
        builder: (ctx, setModalState) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text('Add tests to package', style: Mhn.t(16, w: FontWeight.w700)),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView.builder(
                  itemCount: available.length,
                  itemBuilder: (_, i) {
                    final t = available[i];
                    return ListTile(
                      title: Text(t.name, style: Mhn.t(14, w: FontWeight.w600)),
                      subtitle: Text(rs(t.price), style: Mhn.t(12, c: Mhn.mutedSoft)),
                      trailing: const Icon(Icons.add_circle_outline, color: Mhn.green),
                      onTap: () {
                        setState(() => _selected.add(t.id));
                        Navigator.of(ctx).pop();
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Widget _sampleDataNote(String text) => Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFEAF2EE),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline, color: Mhn.muted, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Sample data', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.muted)),
                const SizedBox(height: 2),
                Text(text, style: Mhn.t(11, c: Mhn.mutedSoft)),
              ],
            ),
          ),
        ],
      ),
    );

/// S08: Favorites Screen
class MhnFavoritesScreen extends ConsumerWidget {
  const MhnFavoritesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final favIds = ref.watch(mhnProvider.select((s) => s.favorites));
    final favTests = kTests.where((t) => favIds.contains(t.id)).toList();
    final favPkgs = kPackages.where((p) => favIds.contains(p.id)).toList();

    return MhnPage(
      title: 'Favorites',
      child: (favTests.isEmpty && favPkgs.isEmpty)
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Container(
                      width: 72,
                      height: 72,
                      decoration: const BoxDecoration(
                        color: Color(0xFFF3F7F4),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.favorite_border, color: Mhn.muted, size: 36),
                    ),
                    const SizedBox(height: 16),
                    Text('No favorites yet', style: Mhn.h2),
                    const SizedBox(height: 8),
                    Text(
                      'Tap the heart icon on any lab test or package to save it here for fast booking.',
                      textAlign: TextAlign.center,
                      style: Mhn.t(13, c: Mhn.muted),
                    ),
                  ],
                ),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (favTests.isNotEmpty) ...[
                  Text('Favorite Tests (${favTests.length})', style: Mhn.t(16, w: FontWeight.w700)),
                  const SizedBox(height: 10),
                  for (final t in favTests)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: MhnCard(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(t.name, style: Mhn.t(14, w: FontWeight.w700)),
                                  const SizedBox(height: 2),
                                  Text('${t.fasting} · Report ${t.report}', style: Mhn.t(12, c: Mhn.muted)),
                                  const SizedBox(height: 4),
                                  Text(rs(t.price), style: Mhn.t(14, w: FontWeight.w800, c: Mhn.green)),
                                ],
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.favorite, color: Color(0xFFC24141)),
                              onPressed: () => ref.read(mhnProvider.notifier).toggleFavorite(t.id),
                            ),
                            const SizedBox(width: 4),
                            Consumer(
                              builder: (_, r, __) {
                                final inCart = r.watch(mhnProvider.select((s) => s.cart.contains(t.id)));
                                return ElevatedButton(
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: inCart ? Mhn.tint : Mhn.green,
                                    foregroundColor: inCart ? Mhn.green : Mhn.white,
                                    elevation: 0,
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                  ),
                                  onPressed: () => r.read(mhnProvider.notifier).toggleCart(t.id),
                                  child: Text(inCart ? 'Added' : 'Book'),
                                );
                              },
                            ),
                          ],
                        ),
                      ),
                    ),
                  const SizedBox(height: 16),
                ],
                if (favPkgs.isNotEmpty) ...[
                  Text('Favorite Packages (${favPkgs.length})', style: Mhn.t(16, w: FontWeight.w700)),
                  const SizedBox(height: 10),
                  for (final p in favPkgs)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: MhnCard(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(p.name, style: Mhn.t(14, w: FontWeight.w700)),
                                  const SizedBox(height: 2),
                                  Text(p.params, style: Mhn.t(12, c: Mhn.muted)),
                                  const SizedBox(height: 4),
                                  Text(rs(p.price), style: Mhn.t(14, w: FontWeight.w800, c: Mhn.green)),
                                ],
                              ),
                            ),
                            IconButton(
                              icon: const Icon(Icons.favorite, color: Color(0xFFC24141)),
                              onPressed: () => ref.read(mhnProvider.notifier).toggleFavorite(p.id),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ],
            ),
    );
  }
}

/// S16: Prescription Upload Screen
class MhnPrescriptionScreen extends ConsumerStatefulWidget {
  const MhnPrescriptionScreen({super.key});

  @override
  ConsumerState<MhnPrescriptionScreen> createState() => _MhnPrescriptionScreenState();
}

class _MhnPrescriptionScreenState extends ConsumerState<MhnPrescriptionScreen> {
  String? _selectedFile;
  bool _uploading = false;
  String _selectedPatient = 'Aayush Shrestha (Self)';

  void _simulateUpload(String source) {
    setState(() {
      _selectedFile = 'prescription_${DateTime.now().millisecondsSinceEpoch}.jpg ($source)';
    });
  }

  @override
  Widget build(BuildContext context) {
    return MhnPage(
      title: 'Upload Prescription',
      bottom: _selectedFile != null
          ? MhnButton(
              label: _uploading ? 'Verifying prescription...' : 'Submit Prescription',
              onPressed: _uploading
                  ? null
                  : () async {
                      setState(() => _uploading = true);
                      await Future<void>.delayed(const Duration(milliseconds: 900));
                      if (!mounted) return;
                      setState(() => _uploading = false);
                      mhnToast(context, 'Prescription received! A lab advisor will call you shortly.');
                      Navigator.of(context).maybePop();
                    },
            )
          : null,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: const Color(0xFFF3F7F5),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Mhn.line),
            ),
            child: Row(
              children: [
                const MhnAvatar(name: 'Dr. Meera L.', radius: 26),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Have a doctor’s note?', style: Mhn.t(15, w: FontWeight.w700)),
                      const SizedBox(height: 3),
                      Text(
                        'Upload a photo of your prescription. Our certified medical advisors will extract the tests and call you.',
                        style: Mhn.t(12, c: Mhn.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 22),
          Text('Choose Patient', style: Mhn.t(15, w: FontWeight.w700)),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
            decoration: BoxDecoration(
              color: Mhn.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Mhn.line),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: _selectedPatient,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(value: 'Aayush Shrestha (Self)', child: Text('Aayush Shrestha (Self)')),
                  DropdownMenuItem(value: 'Sita Sharma (Mother)', child: Text('Sita Sharma (Mother)')),
                  DropdownMenuItem(value: 'Anika Sharma (Daughter)', child: Text('Anika Sharma (Daughter)')),
                ],
                onChanged: (v) => setState(() => _selectedPatient = v ?? _selectedPatient),
              ),
            ),
          ),
          const SizedBox(height: 22),
          Text('Upload Method', style: Mhn.t(15, w: FontWeight.w700)),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => _simulateUpload('Camera'),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 20),
                    decoration: BoxDecoration(
                      color: Mhn.white,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: Mhn.line),
                    ),
                    child: Column(
                      children: [
                        const Icon(Icons.photo_camera_outlined, size: 36, color: Mhn.green),
                        const SizedBox(height: 8),
                        Text('Take photo', style: Mhn.t(14, w: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text('Camera', style: Mhn.t(11, c: Mhn.muted)),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(14),
                  onTap: () => _simulateUpload('Gallery/PDF'),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 20),
                    decoration: BoxDecoration(
                      color: Mhn.white,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: Mhn.line),
                    ),
                    child: Column(
                      children: [
                        const Icon(Icons.picture_as_pdf_outlined, size: 36, color: Mhn.green),
                        const SizedBox(height: 8),
                        Text('Browse file', style: Mhn.t(14, w: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text('PDF / Gallery', style: Mhn.t(11, c: Mhn.muted)),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
          if (_selectedFile != null) ...[
            const SizedBox(height: 18),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFE8F5E9),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFA5D6A7)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.check_circle, color: Mhn.green, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(_selectedFile!, style: Mhn.t(13, w: FontWeight.w600, c: Mhn.green)),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18, color: Mhn.muted),
                    onPressed: () => setState(() => _selectedFile = null),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 24),
          _sampleDataNote('Your prescription is kept strictly confidential and only accessed by certified MetroLabs clinical personnel.'),
        ],
      ),
    );
  }
}

