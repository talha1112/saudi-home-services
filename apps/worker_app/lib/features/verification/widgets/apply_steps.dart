import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hs_client/hs_client.dart';

import '../../../app/theme/app_colors.dart';
import '../../../core/extensions/context_extensions.dart';
import '../../../core/utils/text_styles.dart';
import '../../../shared/components/cards.dart';
import '../../../shared/components/inputs.dart';
import '../../../shared/models/worker_data.dart';
import '../../../shared/widgets/tap.dart';
import '../../../shared/widgets/tiles.dart';
import '../utils/onboarding_text.dart';
import 'apply_form.dart';

/// Selected state styled like the reference's teal "chip".
class TealChip extends StatelessWidget {
  const TealChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.height = 36,
    this.fontSize = 13,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final double height;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    return SelectChip(
      label: label,
      selected: selected,
      onTap: onTap,
      height: height,
      radius: height / 2,
      fontSize: fontSize,
      weight: 500,
      horizontal: 13,
      selectedBg: AppColors.tealTint,
      selectedFg: AppColors.primary,
      selectedBorder: AppColors.tealBorder,
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, {this.top = 0});
  final String text;
  final double top;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(top: top),
    child: Text(text, style: ts(13, w: 600)),
  );
}

class _InputBox extends StatelessWidget {
  const _InputBox({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    height: 54,
    alignment: AlignmentDirectional.centerStart,
    padding: const EdgeInsets.symmetric(horizontal: 14),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: AppColors.line, width: 1.5),
    ),
    child: child,
  );
}

/// Step 1: name, introduction and years of experience (the fields `PUT /workers/me/profile` accepts).
class PersonalStep extends StatelessWidget {
  const PersonalStep({
    super.key,
    required this.draft,
    required this.onUpload,
    required this.onRemove,
  });
  final ApplyDraft draft;

  /// The profile photo is a document of kind PHOTO: it is stored by the same upload the documents use, and is shown to the reviewer.
  final Future<void> Function(DocumentKind kind) onUpload;
  final Future<void> Function(String documentId) onRemove;

  @override
  Widget build(BuildContext context) {
    final ob = context.onboarding;
    final photos = [
      for (final d in ob.onboarding?.documents ?? const <WorkerDocument>[])
        if (d.kind == DocumentKind.photo) d,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _DocRow(
          kind: DocumentKind.photo,
          title: Ob.docName(DocumentKind.photo, context.isAr),
          tag: context.l(Ob.photoNote),
          docs: photos,
          busy: ob.busy,
          onUpload: () => onUpload(DocumentKind.photo),
          onRemove: onRemove,
        ),
        _Label(context.l(Ob.fullName), top: 18),
        const SizedBox(height: 7),
        _InputBox(
          child: BareField(
            controller: draft.fullName,
            onChanged: (_) => draft.touch(),
            fontSize: 15,
            weight: 500,
          ),
        ),
        _Label(context.l(Ob.fullNameAr), top: 14),
        const SizedBox(height: 7),
        _InputBox(
          child: BareField(
            controller: draft.fullNameAr,
            onChanged: (_) => draft.touch(),
            fontSize: 15,
            weight: 500,
          ),
        ),
        _Label(context.l(Ob.years), top: 14),
        const SizedBox(height: 7),
        _InputBox(
          child: BareField(
            controller: draft.years,
            hint: context.l(Ob.yearsHint),
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(2),
            ],
            onChanged: (_) => draft.touch(),
            fontSize: 15,
            weight: 500,
            family: kLatinFont,
          ),
        ),
        _Label(context.l(Ob.bio), top: 14),
        const SizedBox(height: 7),
        TextAreaBox(
          controller: draft.bio,
          hint: context.l(Ob.bioHint),
          height: 120,
          onChanged: (_) => draft.touch(),
        ),
      ],
    );
  }
}

/// Step 2: services and cities, taken from the server's catalog (never from a hard-coded list).
class ServicesStep extends StatelessWidget {
  const ServicesStep({super.key, required this.draft});
  final ApplyDraft draft;

  @override
  Widget build(BuildContext context) {
    final ob = context.onboarding;
    final catalog = ob.catalog;
    final ar = context.isAr;
    if (catalog == null) {
      return Column(
        children: [
          const SizedBox(height: 24),
          if (ob.failure != null) ...[
            Text(
              onboardingMessage(context, ob.failure!),
              textAlign: TextAlign.center,
              style: ts(14, c: AppColors.danger),
            ),
            const SizedBox(height: 12),
            Tap(
              onTap: ob.loadCatalog,
              child: Text(
                context.l(Ob.retry),
                key: const Key('catalog-retry'),
                style: ts(14.5, w: 600, c: AppColors.primary),
              ),
            ),
          ] else
            Text(
              context.l(Ob.loadingCatalog),
              style: ts(14, c: AppColors.slate),
            ),
        ],
      );
    }
    return ListenableBuilder(
      listenable: draft,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Label(context.l(Ob.services)),
          if (!catalog.categories.any((c) => c.services.isNotEmpty))
            _EmptyOptions(
              key: const Key('no-services'),
              text: context.l(Ob.noServicesYet),
              onRetry: () => context.onboarding.reloadCatalog(),
            ),
          for (final category in catalog.categories)
            if (category.services.isNotEmpty) ...[
              const SizedBox(height: 14),
              Text(
                category.name(arabic: ar),
                style: ts(12.5, w: 600, c: AppColors.slate),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final s in category.services)
                    TealChip(
                      key: Key('service-${s.id}'),
                      label: s.name(arabic: ar),
                      selected: draft.services.contains(s.id),
                      onTap: () => draft.toggleService(s.id),
                    ),
                ],
              ),
            ],
          _Label(context.l(Ob.cities), top: 22),
          const SizedBox(height: 14),
          if (catalog.cities.isEmpty)
            _EmptyOptions(
              key: const Key('no-cities'),
              text: context.l(Ob.noCitiesYet),
              onRetry: () => context.onboarding.reloadCatalog(),
            ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final c in catalog.cities)
                TealChip(
                  key: Key('city-${c.id}'),
                  label: c.name(arabic: ar),
                  selected: draft.cities.contains(c.id),
                  onTap: () => draft.toggleCity(c.id),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// What a list of choices says when the server has none yet, with a way to ask again.
class _EmptyOptions extends StatelessWidget {
  const _EmptyOptions({super.key, required this.text, required this.onRetry});
  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(text, style: ts(13.5, c: AppColors.slate, h: 1.45)),
          ),
          Tap(
            onTap: onRetry,
            child: Text(
              context.l(Ob.retry),
              style: ts(13.5, w: 600, c: AppColors.primary),
            ),
          ),
        ],
      ),
    );
  }
}

/// Index in the Saturday-first weekday row -> the backend's day number (0 = Sunday ... 6 = Saturday).
int backendDay(int rowIndex) => (rowIndex + 6) % 7;

/// Step 3: working days and hours (one daily window applied to every chosen day).
class AvailabilityStep extends StatelessWidget {
  const AvailabilityStep({super.key, required this.draft});
  final ApplyDraft draft;

  Future<void> _pick(
    BuildContext context,
    TimeOfDay initial,
    ValueChanged<TimeOfDay> done,
  ) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: initial,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: true),
        child: child!,
      ),
    );
    if (picked != null) done(picked);
  }

  @override
  Widget build(BuildContext context) {
    Widget hourBox(
      String label,
      TimeOfDay value,
      VoidCallback onTap,
      Key key,
    ) => Expanded(
      child: Tap(
        onTap: onTap,
        child: Container(
          key: key,
          height: 56,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.line, width: 1.5),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: ts(11.5, c: AppColors.slate)),
              const SizedBox(height: 1),
              Text(
                ApplyDraft.format(value),
                style: ts(15, w: 600, family: kLatinFont),
              ),
            ],
          ),
        ),
      ),
    );

    return ListenableBuilder(
      listenable: draft,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Label(context.l(Ob.days)),
          const SizedBox(height: 14),
          Row(
            children: [
              for (var i = 0; i < kWeekdays.length; i++) ...[
                if (i > 0) const SizedBox(width: 6),
                Expanded(
                  child: Tap(
                    onTap: () => draft.toggleDay(backendDay(i)),
                    child: Container(
                      key: Key('day-${backendDay(i)}'),
                      height: 46,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: draft.days.contains(backendDay(i))
                            ? AppColors.primary
                            : Colors.white,
                        borderRadius: BorderRadius.circular(13),
                        border: Border.all(
                          color: draft.days.contains(backendDay(i))
                              ? AppColors.primary
                              : AppColors.line,
                          width: 1.5,
                        ),
                      ),
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          context.l(kWeekdays[i]),
                          style: ts(
                            12,
                            w: 600,
                            c: draft.days.contains(backendDay(i))
                                ? Colors.white
                                : AppColors.text,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
          _Label(context.l(Ob.hours), top: 20),
          const SizedBox(height: 14),
          Row(
            children: [
              hourBox(
                context.l(Ob.from),
                draft.from,
                () => _pick(context, draft.from, draft.setFrom),
                const Key('hours-from'),
              ),
              const SizedBox(width: 10),
              hourBox(
                context.l(Ob.to),
                draft.to,
                () => _pick(context, draft.to, draft.setTo),
                const Key('hours-to'),
              ),
            ],
          ),
          if (!draft.hoursValid) ...[
            const SizedBox(height: 10),
            Text(
              context.isAr
                  ? 'يجب أن تكون ساعة النهاية بعد ساعة البداية.'
                  : 'The end time must be after the start time.',
              style: ts(13, c: AppColors.danger),
            ),
          ],
        ],
      ),
    );
  }
}

/// Step 4: documents. Each row shows exactly what the server stores; nothing is marked done until the server confirmed the upload.
class DocumentsStep extends StatelessWidget {
  const DocumentsStep({
    super.key,
    required this.onUpload,
    required this.onRemove,
  });

  final Future<void> Function(DocumentKind kind) onUpload;
  final Future<void> Function(String documentId) onRemove;

  static const _kinds = [
    (DocumentKind.nationalId, true),
    (DocumentKind.iqama, true),
    (DocumentKind.certificate, false),
    (DocumentKind.professionalLicense, false),
  ];

  @override
  Widget build(BuildContext context) {
    final ob = context.onboarding;
    final ar = context.isAr;
    final docs = ob.onboarding?.documents ?? const <WorkerDocument>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          context.l(Ob.docsIntro),
          style: ts(14, c: AppColors.slate, h: 1.5),
        ),
        for (final (kind, identity) in _kinds) ...[
          const SizedBox(height: 14),
          _DocRow(
            kind: kind,
            title: Ob.docName(kind, ar),
            tag: identity
                ? context.l(Ob.docRequiredNote)
                : context.l(Ob.optional),
            docs: [
              for (final d in docs)
                if (d.kind == kind) d,
            ],
            busy: ob.busy,
            onUpload: () => onUpload(kind),
            onRemove: onRemove,
          ),
        ],
        const SizedBox(height: 14),
        InfoNote(context.tr('docsPrivacy'), icon: 'lock', radius: 14),
      ],
    );
  }
}

class _DocRow extends StatelessWidget {
  const _DocRow({
    required this.kind,
    required this.title,
    required this.tag,
    required this.docs,
    required this.busy,
    required this.onUpload,
    required this.onRemove,
  });

  final DocumentKind kind;
  final String title;
  final String tag;
  final List<WorkerDocument> docs;
  final bool busy;
  final VoidCallback onUpload;
  final Future<void> Function(String documentId) onRemove;

  @override
  Widget build(BuildContext context) {
    final ar = context.isAr;
    final has = docs.any((d) => d.isUsable);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: has ? AppColors.tealSoftBorder : AppColors.lineSoft,
          width: 1.5,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              IconTile(
                has ? 'check' : 'file',
                size: 42,
                radius: 14,
                iconSize: 19,
                bg: has ? AppColors.tealTint : AppColors.chip,
                fg: has ? AppColors.primary : AppColors.text,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: ts(14.5, w: 600)),
                    const SizedBox(height: 2),
                    Text(tag, style: ts(12, c: AppColors.slate)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Tap(
                onTap: busy ? null : onUpload,
                child: Container(
                  key: Key('upload-${kind.wire}'),
                  height: 36,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: busy
                        ? AppColors.chip
                        : (has ? AppColors.chip : AppColors.primary),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Text(
                    context.l(has ? Ob.replace : Ob.upload),
                    style: ts(
                      12.5,
                      w: 600,
                      c: busy || has ? AppColors.text : Colors.white,
                    ),
                  ),
                ),
              ),
            ],
          ),
          for (final d in docs) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        d.fileName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ts(12.5, w: 500, family: kLatinFont),
                      ),
                      Text(
                        Ob.docState(d, ar),
                        key: Key('doc-state-${d.id}'),
                        style: ts(
                          12,
                          c: d.isRejected ? AppColors.danger : AppColors.slate,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Tap(
                  onTap: busy ? null : () => onRemove(d.id),
                  child: Text(
                    context.l(Ob.remove),
                    key: Key('remove-${d.id}'),
                    style: ts(12.5, w: 600, c: AppColors.danger),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
