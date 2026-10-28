import 'package:flutter/material.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/components/sheets.dart';
import '../../../shared/widgets/app_icon.dart';
import '../../../shared/widgets/tap.dart';
import '../logic/booking_submitter.dart';
import '../logic/picked_photo.dart';

/// What the customer needs fixed, and optionally photos of it. Photos are not part of `POST /bookings`: they are attached to the request
/// right after it is created.
class DetailsStep extends StatefulWidget {
  const DetailsStep({super.key});

  @override
  State<DetailsStep> createState() => _DetailsStepState();
}

class _DetailsStepState extends State<DetailsStep> {
  late final TextEditingController _description = TextEditingController(
    text: context.appRead.description,
  );

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  bool _skipped = false;

  Future<void> _addPhotos() async {
    final app = context.appRead;
    final room = kMaxBookingPhotos - app.photos.length;
    if (room <= 0) return;
    final source = await showAppSheet<PhotoSource>(
      context,
      builder: (_) => const _SourceSheet(),
    );
    if (source == null || !mounted) return;
    final pick = await PhotoPicking.pick(room, source);
    if (!mounted) return;
    setState(() => _skipped = pick.skipped);
    if (pick.photos.isNotEmpty) {
      app.update(
        () => app.photos.addAll(
          pick.photos.take(kMaxBookingPhotos - app.photos.length),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final length = app.description.trim().length;
    final tooShort = length < BookingDraft.minDescription;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('describe'), style: ts(21, w: 700)),
        const SizedBox(height: 16),
        TextAreaBox(
          controller: _description,
          hint: context.tr('descPh'),
          onChanged: (v) => app.update(() => app.description = v),
        ),
        const SizedBox(height: 8),
        Text(
          tooShort
              ? context
                    .tr('descMin')
                    .replaceAll('{n}', '${BookingDraft.minDescription}')
              : '$length / ${BookingDraft.maxDescription}',
          key: const Key('description-hint'),
          style: ts(12.5, c: tooShort ? AppColors.slate : AppColors.primary),
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            Text(context.tr('phTitle'), style: ts(15, w: 700)),
            const SizedBox(width: 8),
            Text(context.tr('optional'), style: ts(12.5, c: AppColors.slate)),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          context.tr('phHint').replaceAll('{n}', '$kMaxBookingPhotos'),
          style: ts(12.5, c: AppColors.slate, h: 1.4),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 84,
          child: ListView(
            key: const Key('photo-strip'),
            scrollDirection: Axis.horizontal,
            children: [
              for (var i = 0; i < app.photos.length; i++)
                _Thumb(
                  key: Key('photo-$i'),
                  photo: app.photos[i],
                  onRemove: () => app.update(() => app.photos.removeAt(i)),
                ),
              if (app.photos.length < kMaxBookingPhotos)
                Tap(
                  key: const Key('photo-add'),
                  onTap: _addPhotos,
                  child: Container(
                    width: 84,
                    height: 84,
                    decoration: BoxDecoration(
                      color: AppColors.tealTint,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppColors.line, width: 1.5),
                    ),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const AppIcon(
                          'image',
                          size: 22,
                          color: AppColors.primary,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          context.tr('add'),
                          style: ts(12, w: 600, c: AppColors.primary),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (_skipped) ...[
          const SizedBox(height: 8),
          Text(
            context.tr('phTooBig'),
            key: const Key('photo-skipped'),
            style: ts(12.5, c: AppColors.danger),
          ),
        ],
        const SizedBox(height: 16),
        InfoNote(context.tr('quoteExplain')),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({super.key, required this.photo, required this.onRemove});
  final PickedPhoto photo;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 10),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Image.memory(
              photo.bytes,
              width: 84,
              height: 84,
              fit: BoxFit.cover,
              cacheWidth: 252,
            ),
          ),
          PositionedDirectional(
            top: -6,
            end: -6,
            child: Semantics(
              label: context.tr('phRemove'),
              button: true,
              child: Tap(
                key: const Key('photo-remove'),
                onTap: onRemove,
                child: Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    color: AppColors.text,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 2),
                  ),
                  child: const AppIcon('x', size: 12, color: Colors.white),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "Take a photo" or "Choose from gallery".
class _SourceSheet extends StatelessWidget {
  const _SourceSheet();

  @override
  Widget build(BuildContext context) {
    Widget option(String key, String icon, String label, PhotoSource source) =>
        Tap(
          key: Key(key),
          onTap: () => Navigator.of(context).pop(source),
          child: Container(
            padding: const EdgeInsets.all(14),
            margin: const EdgeInsets.only(bottom: 10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.lineSoft, width: 1.5),
            ),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.tealTint,
                    borderRadius: BorderRadius.circular(13),
                  ),
                  child: AppIcon(icon, size: 19, color: AppColors.primary),
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(label, style: ts(15, w: 600))),
              ],
            ),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(context.tr('phTitle'), style: ts(20, w: 700)),
        const SizedBox(height: 14),
        option(
          'photo-source-camera',
          'camera',
          context.tr('phCamera'),
          PhotoSource.camera,
        ),
        option(
          'photo-source-gallery',
          'image',
          context.tr('phGallery'),
          PhotoSource.gallery,
        ),
      ],
    );
  }
}
