// LimsError shape (IC §4.1; CV §6). `code` holds a LimsErrorCodes.* value (error_codes.g.dart).

class FieldError {
  const FieldError({required this.path, required this.code, required this.message});
  final String path;
  final String code;
  final String message;
}

class LimsException implements Exception {
  LimsException(this.code, {this.safeDetail, this.fieldErrors});
  final String code;
  final String? safeDetail;
  final List<FieldError>? fieldErrors;
  @override
  String toString() => safeDetail == null ? 'LimsException($code)' : 'LimsException($code): $safeDetail';
}
