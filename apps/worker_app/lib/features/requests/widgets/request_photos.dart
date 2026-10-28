import 'package:flutter/material.dart';

import '../../../app/jobs_scope.dart';
import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';

/// The photos the customer attached to a request, as a strip of thumbnails; tapping one opens it full screen. Each photo is fetched through a
/// short-lived signed link the backend hands out (only to a worker who may see the request), never through a stored address.
class RequestPhotos extends StatelessWidget {
  const RequestPhotos({
    super.key,
    required this.bookingId,
    required this.photoIds,
  });

  final String bookingId;
  final List<String> photoIds;

  @override
  Widget build(BuildContext context) {
    if (photoIds.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      height: 92,
      child: ListView.separated(
        key: const Key('photo-strip'),
        scrollDirection: Axis.horizontal,
        itemCount: photoIds.length,
        separatorBuilder: (_, _) => const SizedBox(width: 10),
        itemBuilder: (_, i) =>
            _Thumb(bookingId: bookingId, photoId: photoIds[i], index: i),
      ),
    );
  }
}

class _Thumb extends StatefulWidget {
  const _Thumb({
    required this.bookingId,
    required this.photoId,
    required this.index,
  });
  final String bookingId;
  final String photoId;
  final int index;

  @override
  State<_Thumb> createState() => _ThumbState();
}

class _ThumbState extends State<_Thumb> {
  Future<String?>? _url;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _url ??= JobsScope.of(
      context,
    ).jobs.photoUrl(widget.bookingId, widget.photoId);
  }

  void _open(String url) {
    showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black,
        insetPadding: const EdgeInsets.all(12),
        child: Stack(
          children: [
            InteractiveViewer(
              child: Image.network(
                url,
                fit: BoxFit.contain,
                errorBuilder: (_, _, _) => const _Broken(size: 240),
              ),
            ),
            PositionedDirectional(
              top: 8,
              end: 8,
              child: Tap(
                key: const Key('photo-close'),
                onTap: () => Navigator.of(ctx).pop(),
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: const BoxDecoration(
                    color: Colors.black54,
                    shape: BoxShape.circle,
                  ),
                  child: const AppIcon('x', size: 18, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<String?>(
      future: _url,
      builder: (context, snap) {
        final url = snap.data;
        Widget child;
        if (snap.connectionState != ConnectionState.done) {
          child = const Center(
            child: SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2.2),
            ),
          );
        } else if (url == null) {
          child = const _Broken(size: 92);
        } else {
          child = Image.network(
            url,
            width: 92,
            height: 92,
            fit: BoxFit.cover,
            cacheWidth: 276,
            errorBuilder: (_, _, _) => const _Broken(size: 92),
            loadingBuilder: (_, image, progress) => progress == null
                ? image
                : const Center(
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2.2),
                    ),
                  ),
          );
        }
        return Tap(
          key: Key('photo-${widget.index}'),
          onTap: url == null ? null : () => _open(url),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Container(
              width: 92,
              height: 92,
              color: AppColors.chip,
              child: child,
            ),
          ),
        );
      },
    );
  }
}

class _Broken extends StatelessWidget {
  const _Broken({required this.size});
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const AppIcon('image', size: 22, color: AppColors.slate),
          const SizedBox(height: 4),
          Text(
            context.tr('wjPhotoFailed'),
            textAlign: TextAlign.center,
            style: ts(11, c: AppColors.slate),
          ),
        ],
      ),
    );
  }
}
