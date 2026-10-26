import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';

/// Decorative QR-style block shown on the invoice.
class InvoiceCode extends StatelessWidget {
  const InvoiceCode({super.key});

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: .85,
      child: SizedBox(
        width: 72,
        height: 72,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: CustomPaint(painter: _CodePainter()),
        ),
      ),
    );
  }
}

class _CodePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.white);
    final ink = Paint()..color = AppColors.text;
    for (var x = 0.0; x < size.width; x += 6) {
      canvas.drawRect(Rect.fromLTWH(x, 0, 3, size.height), ink);
    }
    // White bands across the middle 52x52 area.
    final band = Paint()..color = Colors.white;
    const inset = 10.0;
    for (var y = inset; y < size.height - inset; y += 7) {
      canvas.drawRect(
        Rect.fromLTWH(inset, y + 4, size.width - inset * 2, 3),
        band,
      );
    }
  }

  @override
  bool shouldRepaint(_CodePainter old) => false;
}
