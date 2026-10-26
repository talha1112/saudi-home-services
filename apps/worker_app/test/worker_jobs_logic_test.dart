import 'package:flutter_test/flutter_test.dart';
import 'package:hs_client/hs_client.dart';
import 'package:hs_client/testing.dart';
import 'package:worker_app/features/jobs/logic/worker_jobs_controller.dart';
import 'package:worker_app/features/quotes/logic/quote_submitter.dart';
import 'package:worker_app/features/quotes/logic/quote_window.dart';

import 'support/worker_harness.dart';

ApiException _api(
  int status,
  String code, {
  String? message,
  Map<String, dynamic>? details,
}) => ApiException(
  status: status,
  code: code,
  message: message,
  details: details,
);

SubmitQuoteRequest _quote({int price = 25000}) => SubmitQuoteRequest(
  priceHalalas: price,
  proposedStartAt: DateTime.utc(2026, 11, 3, 15),
  proposedEndAt: DateTime.utc(2026, 11, 3, 17),
  message: 'Parts included',
  validForHours: 24,
);

Future<({TestHsClient kit, WorkerJobsController jobs, QuoteSubmitter quotes})>
_rig({bool signedIn = true}) async {
  final kit = workerKit();
  if (signedIn) await signInWorker(kit);
  final s = makeJobsServices(kit);
  addTearDown(() {
    s.jobs.dispose();
    s.quotes.dispose();
    kit.client.auth.dispose();
  });
  return (kit: kit, jobs: s.jobs, quotes: s.quotes);
}

void main() {
  group(
    'requests and jobs are the backend\'s, split by who has quoted and by state',
    () {
      test(
        'open requests split into "new" and "quoted"; jobs by their state',
        () async {
          final r = await _rig();
          r.kit.api.workerRequestList.addAll([
            request(id: 'a', reference: 'HS-A'),
            request(
              id: 'b',
              reference: 'HS-B',
              quote: WorkerQuote(
                id: 'q',
                bookingId: 'b',
                bookingReference: 'HS-B',
                status: 'SUBMITTED',
                version: 1,
                money: money(),
                proposedStartAt: DateTime.utc(2026, 11, 3),
                proposedEndAt: DateTime.utc(2026, 11, 3, 2),
                validUntil: DateTime.utc(2026, 11, 4),
                isExpired: false,
              ),
            ),
          ]);
          r.kit.api.workerJobList.addAll([
            job(id: 'j1', status: 'PAYMENT_PENDING', released: false),
            job(id: 'j2', status: 'CONFIRMED'),
            job(id: 'j3', status: 'IN_PROGRESS'),
            job(id: 'j4', status: 'COMPLETED'),
            job(id: 'j5', status: 'CANCELLED', released: false),
          ]);

          expect(r.jobs.requestsStatus, LoadStatus.idle);
          await r.jobs.refresh();

          expect(r.jobs.requestsStatus, LoadStatus.ready);
          expect(r.jobs.newRequests.map((x) => x.id), ['a']);
          expect(r.jobs.quotedRequests.map((x) => x.id), ['b']);
          expect(
            r.jobs.jobsIn({'PAYMENT_PENDING', 'CONFIRMED'}).map((x) => x.id),
            ['j1', 'j2'],
          );
          expect(r.jobs.jobsIn({'IN_PROGRESS'}).map((x) => x.id), ['j3']);
          expect(r.jobs.jobsIn({'COMPLETED'}).map((x) => x.id), ['j4']);
          expect(r.jobs.jobsIn({'CANCELLED', 'EXPIRED'}).map((x) => x.id), [
            'j5',
          ]);
        },
      );

      test('nothing at all is "ready" and empty, not an error', () async {
        final r = await _rig();
        await r.jobs.refresh();
        expect(r.jobs.requestsStatus, LoadStatus.ready);
        expect(r.jobs.jobsStatus, LoadStatus.ready);
        expect(r.jobs.requests, isEmpty);
        expect(r.jobs.jobs, isEmpty);
        expect(r.jobs.requestsError, isNull);
      });

      test(
        'a first load that fails is "failed"; retrying recovers; a later failed refresh keeps the list',
        () async {
          final r = await _rig();
          r.kit.api.workerRequestsResult = _api(0, 'NETWORK');
          await r.jobs.loadRequests();
          expect(r.jobs.requestsStatus, LoadStatus.failed);
          expect(r.jobs.requestsError!.isNetwork, isTrue);

          r.kit.api.workerRequestsResult = null;
          r.kit.api.workerRequestList.add(request());
          await r.jobs.loadRequests();
          expect(r.jobs.requestsStatus, LoadStatus.ready);
          expect(r.jobs.requests, hasLength(1));

          r.kit.api.workerRequestsResult = _api(503, 'UNAVAILABLE');
          await r.jobs.loadRequests();
          expect(r.jobs.requestsStatus, LoadStatus.ready);
          expect(r.jobs.requestsError, isNotNull);
          expect(
            r.jobs.requests,
            hasLength(1),
            reason: 'what we had stays visible',
          );
        },
      );

      test('overlapping refreshes share one request each', () async {
        final r = await _rig();
        await Future.wait([
          r.jobs.refresh(),
          r.jobs.refresh(),
          r.jobs.refresh(),
        ]);
        expect(
          r.kit.api.calls.where((c) => c == 'workerRequests'),
          hasLength(1),
        );
        expect(r.kit.api.calls.where((c) => c == 'workerJobs'), hasLength(1));
      });

      test(
        'signed out: the list fails as "not signed in" and nothing is requested',
        () async {
          final r = await _rig(signedIn: false);
          await r.jobs.refresh();
          expect(r.jobs.requestsStatus, LoadStatus.failed);
          expect(r.jobs.requestsError!.code, 'NO_SESSION');
          expect(r.kit.api.calls, isNot(contains('workerRequests')));
        },
      );

      test(
        'clear (sign-out) forgets everything so the next worker sees none of it',
        () async {
          final r = await _rig();
          r.kit.api.workerJobList.add(job());
          r.kit.api.workerRequestList.add(request());
          await r.jobs.refresh();
          r.jobs.clear();
          expect(r.jobs.jobs, isEmpty);
          expect(r.jobs.requests, isEmpty);
          expect(r.jobs.jobsStatus, LoadStatus.idle);
        },
      );
    },
  );

  group('ownership', () {
    test(
      'only the bookings the backend lists as this worker\'s are ever known',
      () async {
        final r = await _rig();
        r.kit.api.workerJobList.add(job(id: 'mine'));
        await r.jobs.refresh();
        expect(r.jobs.jobById('mine'), isNotNull);
        expect(r.jobs.jobById('someone-elses'), isNull);
      },
    );

    test(
      'another worker\'s booking is a 404 on reload, and is not added to the list',
      () async {
        final r = await _rig();
        await expectLater(
          r.jobs.reloadJob('someone-elses'),
          throwsA(isA<ApiException>().having((e) => e.status, 'status', 404)),
        );
        expect(r.jobs.jobById('someone-elses'), isNull);
      },
    );

    test(
      'starting or finishing someone else\'s booking is "not found" and changes nothing',
      () async {
        final r = await _rig();
        r.kit.api.workerJobList.add(job(id: 'mine'));
        await r.jobs.refresh();
        expect(
          await r.jobs.startJob('someone-elses'),
          JobActionOutcome.notFound,
        );
        expect(
          await r.jobs.completeJob('someone-elses'),
          JobActionOutcome.notFound,
        );
        expect(r.jobs.jobs.single.status, 'CONFIRMED');
      },
    );
  });

  group('starting and finishing a job', () {
    test(
      'start moves a paid job to IN_PROGRESS, complete to COMPLETED, using the backend\'s answer',
      () async {
        final r = await _rig();
        r.kit.api.workerJobList.add(job(id: 'j'));
        await r.jobs.refresh();

        expect(await r.jobs.startJob('j'), JobActionOutcome.done);
        expect(r.jobs.jobById('j')!.status, 'IN_PROGRESS');
        expect(r.jobs.jobById('j')!.startedAt, isNotNull);
        expect(await r.jobs.completeJob('j'), JobActionOutcome.done);
        expect(r.jobs.jobById('j')!.status, 'COMPLETED');
        expect(r.jobs.jobById('j')!.completedAt, isNotNull);
      },
    );

    test(
      'a job that is not paid yet cannot be started: the backend refuses and the app shows the truth',
      () async {
        final r = await _rig();
        r.kit.api.workerJobList.add(
          job(id: 'j', status: 'PAYMENT_PENDING', released: false),
        );
        await r.jobs.refresh();
        expect(await r.jobs.startJob('j'), JobActionOutcome.wrongState);
        expect(r.jobs.jobById('j')!.status, 'PAYMENT_PENDING');
        expect(r.jobs.jobById('j')!.canStart, isFalse);
      },
    );

    test('taps while a start is running share one request', () async {
      final r = await _rig();
      r.kit.api.workerJobList.add(job(id: 'j'));
      await r.jobs.refresh();
      final results = await Future.wait([
        r.jobs.startJob('j'),
        r.jobs.startJob('j'),
        r.jobs.startJob('j'),
      ]);
      expect(results, everyElement(JobActionOutcome.done));
      expect(r.kit.api.calls.where((c) => c == 'startWorkerJob'), hasLength(1));
      expect(r.jobs.isActing('j'), isFalse);
    });

    test(
      'errors are told apart: no connection, signed out, busy server, anything else',
      () async {
        final r = await _rig();
        r.kit.api.workerJobList.add(job(id: 'j'));
        await r.jobs.refresh();
        r.kit.api.jobActionResult = _api(0, 'NETWORK');
        expect(await r.jobs.startJob('j'), JobActionOutcome.network);
        r.kit.api.jobActionResult = _api(503, 'UNAVAILABLE');
        expect(await r.jobs.startJob('j'), JobActionOutcome.unavailable);
        r.kit.api.jobActionResult = _api(403, 'FORBIDDEN');
        expect(await r.jobs.startJob('j'), JobActionOutcome.failed);
        expect(
          r.jobs.jobById('j')!.status,
          'CONFIRMED',
          reason: 'a failed attempt changes nothing',
        );
        r.kit.api.jobActionResult = null;
        expect(await r.jobs.startJob('j'), JobActionOutcome.done);
      },
    );
  });

  group('sending a quote', () {
    test(
      'sends the worker\'s own price in halalas and the proposed window, and records the server\'s priced answer',
      () async {
        final r = await _rig();
        r.kit.api.workerRequestList.add(request(id: 'req'));
        await r.jobs.loadRequests();

        final quote = await r.quotes.submit('req', _quote());

        expect(quote, isNotNull);
        final (bookingId, sent) = r.kit.api.submittedQuotes.single;
        expect(bookingId, 'req');
        expect(sent.priceHalalas, 25000);
        expect(
          sent.toJson().keys,
          containsAll(['priceHalalas', 'proposedStartAt', 'proposedEndAt']),
        );
        expect(quote!.money.serviceHalalas, 25000);
        expect(
          quote.money.payoutHalalas,
          21250,
          reason: 'computed by the server, not the app',
        );
        // the lists move without another round trip
        expect(r.jobs.newRequests, isEmpty);
        expect(r.jobs.quotedRequests.single.myQuote!.id, quote.id);
        expect(r.quotes.failure, isNull);
      },
    );

    test(
      'a price that is not positive is refused before anything is sent',
      () async {
        final r = await _rig();
        r.kit.api.workerRequestList.add(request(id: 'req'));
        expect(await r.quotes.submit('req', _quote(price: 0)), isNull);
        expect(r.quotes.failure!.problem, QuoteProblem.invalidPrice);
        expect(r.kit.api.submittedQuotes, isEmpty);
      },
    );

    test('taps while it is sending share one request', () async {
      final r = await _rig();
      r.kit.api.workerRequestList.add(request(id: 'req'));
      final results = await Future.wait([
        r.quotes.submit('req', _quote()),
        r.quotes.submit('req', _quote()),
        r.quotes.submit('req', _quote()),
      ]);
      expect(r.kit.api.submittedQuotes, hasLength(1));
      expect(results.map((q) => q!.id).toSet(), hasLength(1));
      expect(r.quotes.busy, isFalse);
    });

    test(
      'the answer was lost but the quote exists: the retry finds it instead of failing or sending a second',
      () async {
        final r = await _rig();
        r.kit.api.workerRequestList.add(request(id: 'req'));
        r.kit.api.submitFailAfterCreating = _api(0, 'NETWORK');

        expect(await r.quotes.submit('req', _quote()), isNull);
        expect(r.quotes.failure!.problem, QuoteProblem.network);
        expect(
          r.kit.api.workerQuoteList,
          hasLength(1),
          reason: 'the server did create it',
        );

        final again = await r.quotes.submit('req', _quote());
        expect(again, isNotNull);
        expect(again!.id, r.kit.api.workerQuoteList.single.id);
        expect(
          r.kit.api.workerQuoteList,
          hasLength(1),
          reason: 'still exactly one quote',
        );
        expect(r.quotes.failure, isNull);
      },
    );

    test('it really was not created: the retry sends it', () async {
      final r = await _rig();
      r.kit.api.workerRequestList.add(request(id: 'req'));
      r.kit.api.submitQuoteResult = _api(0, 'NETWORK');
      expect(await r.quotes.submit('req', _quote()), isNull);
      r.kit.api.submitQuoteResult = null;
      expect(await r.quotes.submit('req', _quote()), isNotNull);
      expect(r.kit.api.workerQuoteList, hasLength(1));
    });

    test(
      'server refusals are told apart and carry the numbers the worker needs',
      () async {
        final r = await _rig();
        r.kit.api.workerRequestList.add(request(id: 'req'));
        await r.jobs.loadRequests();

        Future<QuoteFailure> fail(ApiException e) async {
          r.kit.api.submitQuoteResult = e;
          expect(await r.quotes.submit('req', _quote()), isNull);
          return r.quotes.failure!;
        }

        final low = await fail(
          _api(
            400,
            'PRICE_BELOW_MINIMUM',
            details: {'minServiceChargeHalalas': 9900},
          ),
        );
        expect(low.problem, QuoteProblem.belowMinimum);
        expect(low.limitHalalas, 9900);
        final high = await fail(
          _api(400, 'PRICE_TOO_HIGH', details: {'maxHalalas': 100000000}),
        );
        expect(high.problem, QuoteProblem.aboveMaximum);
        expect(high.limitHalalas, 100000000);
        expect(
          (await fail(
            _api(
              400,
              'INVALID_PROPOSED_WINDOW',
              message: 'The proposed start is in the past',
            ),
          )).problem,
          QuoteProblem.window,
        );
        expect(
          (await fail(_api(409, 'BOOKING_NOT_OPEN'))).problem,
          QuoteProblem.unavailable,
        );
        expect(
          (await fail(_api(404, 'NOT_FOUND'))).problem,
          QuoteProblem.unavailable,
        );
        expect(
          (await fail(_api(409, 'QUOTE_LIMIT_REACHED'))).problem,
          QuoteProblem.full,
        );
        expect(
          (await fail(_api(503, 'UNAVAILABLE'))).problem,
          QuoteProblem.busy,
        );
        expect(
          (await fail(_api(403, 'FORBIDDEN'))).problem,
          QuoteProblem.other,
        );
        expect(
          r.jobs.newRequests,
          hasLength(1),
          reason: 'a refused quote changes nothing',
        );
      },
    );

    test('signed out: nothing is sent', () async {
      final r = await _rig(signedIn: false);
      r.kit.api.workerRequestList.add(request(id: 'req'));
      expect(await r.quotes.submit('req', _quote()), isNull);
      expect(r.quotes.failure!.problem, QuoteProblem.notSignedIn);
      expect(r.kit.api.submittedQuotes, isEmpty);
    });
  });

  group('the time a worker offers', () {
    final now = DateTime.utc(2026, 11, 1, 10);

    test(
      'the customer\'s window is offered as it is when it is still ahead',
      () {
        final w = proposedWindow(
          preferredStart: DateTime.utc(2026, 11, 2, 15),
          preferredEnd: DateTime.utc(2026, 11, 2, 17),
          now: now,
        );
        expect(w.start, DateTime.utc(2026, 11, 2, 15));
        expect(w.end, DateTime.utc(2026, 11, 2, 17));
      },
    );

    test(
      'a start that has passed (an urgent request) moves to shortly from now and keeps the length',
      () {
        final w = proposedWindow(
          preferredStart: DateTime.utc(2026, 11, 1, 9, 30),
          preferredEnd: DateTime.utc(2026, 11, 1, 11, 30),
          now: now,
        );
        expect(w.start, DateTime.utc(2026, 11, 1, 10, 15));
        expect(w.end, DateTime.utc(2026, 11, 1, 12, 15));
        expect(
          w.start.isAfter(now),
          isTrue,
          reason: 'the backend refuses a start in the past',
        );
      },
    );

    test('a missing or backwards window gets a two-hour default', () {
      final w = proposedWindow(
        preferredStart: null,
        preferredEnd: null,
        now: now,
      );
      expect(w.end.difference(w.start), const Duration(hours: 2));
      final b = proposedWindow(
        preferredStart: DateTime.utc(2026, 11, 2, 15),
        preferredEnd: DateTime.utc(2026, 11, 2, 14),
        now: now,
      );
      expect(b.end.difference(b.start), const Duration(hours: 2));
    });

    test('times go out in UTC', () {
      final w = proposedWindow(
        preferredStart: DateTime.parse('2026-11-02T18:00:00+03:00'),
        preferredEnd: DateTime.parse('2026-11-02T20:00:00+03:00'),
        now: now,
      );
      expect(w.start.isUtc, isTrue);
      expect(w.start, DateTime.utc(2026, 11, 2, 15));
    });
  });

  group('the price a worker types', () {
    test('SAR to whole halalas', () {
      expect(parsePriceHalalas('250'), 25000);
      expect(parsePriceHalalas('99.5'), 9950);
      expect(parsePriceHalalas('99.05'), 9905);
      expect(parsePriceHalalas(' 120 '), 12000);
      expect(parsePriceHalalas('١٢٠'), 12000);
      expect(parsePriceHalalas('١٢٫٥'), 1250);
    });

    test(
      'anything that is not a positive amount with at most two decimals is not a price',
      () {
        for (final bad in [
          '',
          '   ',
          '0',
          '0.00',
          'abc',
          '12.345',
          '-5',
          '1e3',
          '12..5',
          '99999999999',
        ]) {
          expect(parsePriceHalalas(bad), isNull, reason: bad);
        }
      },
    );
  });
}
