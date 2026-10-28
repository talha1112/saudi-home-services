import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

/// How many photos one request may carry (the backend's own limit) and the largest one it accepts.
const kMaxBookingPhotos = 5;
const kMaxPhotoBytes = 8 * 1024 * 1024;

/// A problem photo the customer chose, held until the request is created and the photo can be attached to it.
class PickedPhoto {
  const PickedPhoto({
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  final String name;

  /// image/jpeg or image/png: the only types the backend takes.
  final String mimeType;
  final Uint8List bytes;
}

/// What a pick brought back: the photos that can be sent, and whether any was left out for being too large or not a JPEG/PNG.
class PhotoPick {
  const PhotoPick(this.photos, {this.skipped = false});
  final List<PickedPhoto> photos;
  final bool skipped;
}

/// Where a photo comes from.
enum PhotoSource { gallery, camera }

typedef PhotoPicker = Future<PhotoPick> Function(int limit, PhotoSource source);

/// Opens the phone's gallery. Tests replace [pick] (a platform picker cannot run there).
abstract final class PhotoPicking {
  static PhotoPicker pick = _fromGallery;

  static Future<PhotoPick> _fromGallery(int limit, PhotoSource source) async {
    final picker = ImagePicker();
    // Resized and re-encoded by the picker: a phone photo is several MB, a quote does not need that.
    final files = source == PhotoSource.camera
        ? [
            ?await picker.pickImage(
              source: ImageSource.camera,
              maxWidth: 1600,
              imageQuality: 80,
            ),
          ]
        : limit < 2
        ? [
            ?await picker.pickImage(
              source: ImageSource.gallery,
              maxWidth: 1600,
              imageQuality: 80,
            ),
          ]
        : await picker.pickMultiImage(
            limit: limit,
            maxWidth: 1600,
            imageQuality: 80,
          );
    final photos = <PickedPhoto>[];
    var skipped = false;
    for (final f in files.take(limit)) {
      final bytes = await f.readAsBytes();
      final type = sniff(bytes);
      if (type == null || bytes.length > kMaxPhotoBytes) {
        skipped = true;
        continue;
      }
      final base = f.name.isEmpty ? 'photo' : f.name.split('.').first;
      photos.add(
        PickedPhoto(
          name: '$base.${type == 'image/png' ? 'png' : 'jpg'}',
          mimeType: type,
          bytes: bytes,
        ),
      );
    }
    return PhotoPick(photos, skipped: skipped);
  }

  /// The image type from the first bytes (never from the file name), or null when it is neither JPEG nor PNG.
  static String? sniff(Uint8List b) {
    if (b.length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) {
      return 'image/jpeg';
    }
    if (b.length > 4 &&
        b[0] == 0x89 &&
        b[1] == 0x50 &&
        b[2] == 0x4E &&
        b[3] == 0x47) {
      return 'image/png';
    }
    return null;
  }
}
