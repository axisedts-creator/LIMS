// REQ-SEC-103: transient PDFs are the only files the app writes; they die on viewer close and on logout/wipe.
import 'dart:io';

class SecureTempFiles {
  const SecureTempFiles(this.dir);

  final Directory dir;

  /// Deletes everything inside [dir]. Never throws: a file that vanished or is locked must not block a logout wipe.
  Future<void> deleteAll() async {
    if (!dir.existsSync()) return;
    for (final e in dir.listSync(followLinks: false)) {
      try {
        e.deleteSync(recursive: true);
      } on FileSystemException {
        // best effort; the OS clears the cache directory on uninstall
      }
    }
  }
}
