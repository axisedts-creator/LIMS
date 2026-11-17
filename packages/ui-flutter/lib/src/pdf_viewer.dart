// CR-C16-016 LimsPdfViewer: renders a local PDF file with the pinned flutter_pdfview (CR-C16-017); offline only.
import 'dart:io' show File;

import 'package:flutter/material.dart';
import 'package:flutter_pdfview/flutter_pdfview.dart';

import 'base_widgets.dart';

class LimsPdfViewer extends StatefulWidget {
  const LimsPdfViewer({super.key, required this.filePath, required this.onClose, this.errorTitle = 'Could not open this report'});

  final String filePath;
  final VoidCallback onClose;
  final String errorTitle;

  @override
  State<LimsPdfViewer> createState() => _LimsPdfViewerState();
}

class _LimsPdfViewerState extends State<LimsPdfViewer> {
  bool _failed = false;

  bool get _exists {
    try {
      return File(widget.filePath).existsSync();
    } catch (_) {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, c) => Column(mainAxisSize: MainAxisSize.min, children: [
          Align(
            alignment: Alignment.centerRight,
            child: IconButton(icon: const Icon(Icons.close), tooltip: 'Close', onPressed: widget.onClose),
          ),
          if (_failed || !_exists)
            LimsErrorState(title: widget.errorTitle)
          else
            SizedBox(
              height: c.maxHeight.isFinite ? c.maxHeight - 48 : 560,
              child: PDFView(
                filePath: widget.filePath,
                onError: (_) => setState(() => _failed = true),
                onPageError: (_, _) => setState(() => _failed = true),
              ),
            ),
        ]),
      );
}
