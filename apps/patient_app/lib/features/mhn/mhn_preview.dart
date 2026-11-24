// UI preview switch: `--dart-define=MHN_PREVIEW=true` opens the My Health Now UI at /preview WITHOUT signing in, on sample data only.
// Off in every normal build (the const is false), so the signed-out redirect to the sign-in area is unchanged.
const kMhnPreview = bool.fromEnvironment('MHN_PREVIEW');
const kMhnPreviewPath = '/preview';
