import 'package:flutter/material.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/widgets/app_button.dart';

/// Asks for the customer's name and saves it on the server. Completes with true once it was saved.
Future<bool> showEditNameSheet(BuildContext context) async {
  final saved = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
    ),
    builder: (_) => const _EditNameSheet(),
  );
  return saved ?? false;
}

class _EditNameSheet extends StatefulWidget {
  const _EditNameSheet();

  @override
  State<_EditNameSheet> createState() => _EditNameSheetState();
}

class _EditNameSheetState extends State<_EditNameSheet> {
  late final TextEditingController _name = TextEditingController(
    text: context.auth.user?.fullName ?? '',
  );
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  bool get _valid => _name.text.trim().length >= 2;

  Future<void> _save() async {
    if (!_valid || _busy) return;
    final auth = context.authRead;
    final navigator = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await auth.updateName(_name.text.trim().replaceAll(RegExp(r'\s+'), ' '));
      navigator.pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = context.tr(e.status == 0 ? 'profOffline' : 'profSaveFailed');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        20,
        20,
        MediaQuery.viewInsetsOf(context).bottom + 20,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(context.tr('profEditTitle'), style: ts(19, w: 700)),
          const SizedBox(height: 4),
          Text(
            context.tr('profEditSub'),
            style: ts(13.5, c: AppColors.slate, h: 1.45),
          ),
          const SizedBox(height: 16),
          TextField(
            key: const Key('profile-name-field'),
            controller: _name,
            autofocus: true,
            maxLength: 120,
            textCapitalization: TextCapitalization.words,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _save(),
            decoration: InputDecoration(
              labelText: context.tr('profNameLabel'),
              counterText: '',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
              ),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(
              _error!,
              key: const Key('profile-name-error'),
              style: ts(13, c: AppColors.danger),
            ),
          ],
          const SizedBox(height: 16),
          AppButton(
            key: const Key('profile-name-save'),
            label: _busy ? context.tr('profSaving') : context.tr('profSave'),
            enabled: _valid && !_busy,
            onPressed: _save,
          ),
        ],
      ),
    );
  }
}
