import 'package:flutter/material.dart';

/// Tappable wrapper with a subtle pressed state. Disabled when [onTap] is null.
class Tap extends StatefulWidget {
  const Tap({super.key, required this.child, this.onTap});

  final Widget child;
  final VoidCallback? onTap;

  @override
  State<Tap> createState() => _TapState();
}

class _TapState extends State<Tap> {
  bool _down = false;

  void _set(bool v) {
    if (widget.onTap != null && _down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      onTapDown: (_) => _set(true),
      onTapUp: (_) => _set(false),
      onTapCancel: () => _set(false),
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 90),
        opacity: _down ? 0.72 : 1,
        child: widget.child,
      ),
    );
  }
}
