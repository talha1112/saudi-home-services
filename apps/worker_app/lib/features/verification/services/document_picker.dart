import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/widgets.dart';
import 'package:image_picker/image_picker.dart';

/// A document chosen by the person, read into memory (the backend allows at most 10 MB).
class PickedDocument {
  const PickedDocument({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;
}

/// Chooses a document from the phone. Behind an interface so screens can be tested without a platform picker.
abstract class DocumentPicker {
  /// The chosen file, or null when the person cancelled or the file could not be read.
  ///
  /// With [imagesOnly] only JPEG and PNG can be chosen (the profile photo).
  Future<PickedDocument?> pick({bool imagesOnly = false});

  /// Whether the phone's camera can be offered as a second way to add the file.
  bool get hasCamera;

  /// Takes a photo with the camera, or null when the person cancelled or it could not be read.
  Future<PickedDocument?> takePhoto();
}

/// The system file chooser, limited to the types the backend accepts (JPEG, PNG, PDF).
class SystemDocumentPicker implements DocumentPicker {
  const SystemDocumentPicker();

  @override
  bool get hasCamera => true;

  @override
  Future<PickedDocument?> takePhoto() async {
    try {
      final shot = await ImagePicker().pickImage(
        source: ImageSource.camera,
        maxWidth: 2000,
        imageQuality: 85,
      );
      if (shot == null) return null;
      return PickedDocument(
        name: 'camera.jpg',
        bytes: await shot.readAsBytes(),
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<PickedDocument?> pick({bool imagesOnly = false}) async {
    try {
      final file = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: imagesOnly
            ? const ['jpg', 'jpeg', 'png']
            : const ['jpg', 'jpeg', 'png', 'pdf'],
      );
      if (file == null) return null;
      return PickedDocument(name: file.name, bytes: await file.readAsBytes());
    } catch (_) {
      return null;
    }
  }
}

/// Makes the picker available to the document screen.
class DocumentPickerScope extends InheritedWidget {
  const DocumentPickerScope({
    super.key,
    required this.picker,
    required super.child,
  });

  final DocumentPicker picker;

  static DocumentPicker of(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<DocumentPickerScope>();
    return scope?.picker ?? const SystemDocumentPicker();
  }

  @override
  bool updateShouldNotify(DocumentPickerScope oldWidget) =>
      picker != oldWidget.picker;
}
