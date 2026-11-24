import 'dart:convert';
import 'dart:io';

const kInternalCaPem = '''-----BEGIN CERTIFICATE-----
MIIBrTCCAVKgAwIBAgIUeHoN/3qsqdNSUF/3VHKpuIu3YvswCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXTElNUyBpbnRlcm5hbCBDQSAocHJvZCkwHhcNMjYxMTIwMTkx
MDQ3WhcNMzExMTE5MTkxMDQ3WjAiMSAwHgYDVQQDDBdMSU1TIGludGVybmFsIENB
IChwcm9kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABIoFAZXV4is6tVM/k53R
eA9Jw+plQxmh0mP7P84QAmv43QdvTOzm5y6Wd1fkcFJWVCrWbrZYq5nb5NxzZmkp
kYWjZjBkMB0GA1UdDgQWBBShvB2CL5XFQAzC3/xcRY5V3WPq6DAfBgNVHSMEGDAW
gBShvB2CL5XFQAzC3/xcRY5V3WPq6DASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBGAiEA+2aa1dqUT6CXgbi9SiGVNGQl
zFIEKQ/Ucn7HlIIktO4CIQCQi4WKu6piFWXBzCyikwYx8dfFpcde4obwNss2jN5r
TA==
-----END CERTIFICATE-----''';

SecurityContext? buildPatientSecurityContext({required String env, String? caPem}) {
  if (env == 'prod') {
    return null; // Prod keeps system roots
  }
  final pem = (caPem != null && caPem.trim().isNotEmpty) ? caPem : kInternalCaPem;
  final ctx = SecurityContext(withTrustedRoots: false);
  ctx.setTrustedCertificatesBytes(utf8.encode(pem));
  return ctx;
}
