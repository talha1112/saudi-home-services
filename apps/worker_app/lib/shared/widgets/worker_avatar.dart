import 'package:flutter/material.dart';

import '../../core/extensions/context_extensions.dart';
import 'tiles.dart';

/// The worker's own profile photo in the square tile used for their initials. Shows the initials while the photo loads, when there is
/// none, or when it cannot be fetched.
class WorkerAvatar extends StatefulWidget {
  const WorkerAvatar({
    super.key,
    required this.initials,
    this.size = 48,
    this.fontSize = 16,
    this.radius = 16,
  });

  final String initials;
  final double size;
  final double fontSize;
  final double radius;

  @override
  State<WorkerAvatar> createState() => _WorkerAvatarState();
}

class _WorkerAvatarState extends State<WorkerAvatar> {
  String? _url;
  bool _asked = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_asked) return;
    _asked = true;
    context.authRead.workerPhotoUrl().then((url) {
      if (mounted && url != null) setState(() => _url = url);
    });
  }

  @override
  Widget build(BuildContext context) {
    final initials = InitialsTile(
      widget.initials,
      size: widget.size,
      fontSize: widget.fontSize,
      radius: widget.radius,
    );
    final url = _url;
    if (url == null) return initials;
    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.radius),
      child: Image.network(
        url,
        key: const Key('worker-photo'),
        width: widget.size,
        height: widget.size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => initials,
        loadingBuilder: (_, child, progress) =>
            progress == null ? child : initials,
      ),
    );
  }
}
