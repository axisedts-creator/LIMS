// PHLEBO-UI-FULL-1: the phone's file picker for application documents. Photos are shrunk and re-saved as JPEG before
// upload (founder decision 2026-11-26: 2 MB limit, compress); a PDF is sent as it is. Re-saving also drops the photo's
// location and camera details.
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';

import '../domain/application.dart';

Future<PickedFile?> pickApplicationFile(DocKind kind) async {
  final picked = await FilePicker.pickFiles(
    type: FileType.custom,
    allowedExtensions: kind == DocKind.photo ? const ['jpg', 'jpeg', 'png'] : const ['jpg', 'jpeg', 'png', 'pdf'],
  );
  final file = picked.firstOrNull;
  if (file == null) return null;
  final bytes = await file.readAsBytes();
  final raw = PickedFile(name: file.name, bytes: bytes);
  if (raw.extension == 'pdf') return raw;
  try {
    // Long edge about 1600 px at quality 70 keeps a certificate readable at a few hundred KB.
    final small = await FlutterImageCompress.compressWithList(Uint8List.fromList(bytes), minWidth: 1600, minHeight: 1600, quality: 70);
    final base = file.name.contains('.') ? file.name.substring(0, file.name.lastIndexOf('.')) : file.name;
    return PickedFile(name: '$base.jpg', bytes: small);
  } catch (_) {
    return raw; // the size and type rules still apply to the original
  }
}
