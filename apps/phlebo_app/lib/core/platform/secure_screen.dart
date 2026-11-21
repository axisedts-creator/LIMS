// HC-T29 / REQ-SEC-109: contract for the FLAG_SECURE hook. The channel is the one lims_ui's LimsSecureScreen calls
// (enable on first PHI screen mount, disable when the last one leaves); MainActivity.kt implements it. Screens wrap
// themselves in LimsSecureScreen and never call this channel directly.
import 'package:lims_ui/lims_ui.dart';

const String secureScreenChannelName = 'lims_ui/secure_screen';

/// True while the Dart contract (LimsSecureScreen) and the native name above agree; asserted at app start.
bool get secureScreenChannelMatches => LimsSecureScreen.channel.name == secureScreenChannelName;
