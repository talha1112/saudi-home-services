/// Who a real conversation is with. A chat screen opened with a target talks to the backend (`/bookings/:bookingId/messages`); without
/// one it is the prototype conversation (demo builds only).
class ChatTarget {
  const ChatTarget({
    required this.bookingId,
    required this.peerName,
    required this.subtitle,
    this.peerPhone,
    this.support = false,
  });

  /// The person's own conversation with the administrators (support), not a booking chat.
  const ChatTarget.support({required this.peerName, required this.subtitle})
    : bookingId = '',
      peerPhone = null,
      support = true;

  final String bookingId;
  final String peerName;

  /// Under the name in the header: the booking's service or state.
  final String subtitle;

  /// Shown as a call button only when the backend has released it (after payment).
  final String? peerPhone;
  final bool support;
}
